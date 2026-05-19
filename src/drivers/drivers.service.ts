import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import { packageSizesForVehicle } from '../orders/package-size.helper';
// Type-only import — runtime resolution goes through ModuleRef.get to
// avoid the circular dep between drivers/realtime modules.
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  DriverProfile,
  DriverVerificationStatus,
} from './entities/driver-profile.entity';
import { driverStateMachine } from './driver-state-machine';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Vehicle, VehicleStatus } from '../vehicles/entities/vehicle.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { UsersService } from '../users/users.service';
import { Naira, naira } from '../common/money';
import { ErrorCodes } from '../common/constants/error-codes';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import { UpdateDriverVerificationDto } from './dto/update-driver-verification.dto';
import type { User } from '../users/entities/user.entity';

/**
 * Eligible driver shape returned by `findEligibleDrivers`. Flattens the
 * useful columns from the driver_profile ⨝ vehicle_assignments ⨝ vehicles
 * join so the matching engine doesn't have to walk three relations.
 */
export interface EligibleDriver {
  driverId: string;
  userId: string;
  currentLatitude: number | null;
  currentLongitude: number | null;
  vehicleId: string;
  vehicleType: string;
  vehiclePlate: string;
  assignmentId: string;
}

/**
 * Maps a driver verification edge to the audit action recorded against
 * the driver. The state machine narrows the set of legal targets; this
 * helper just rolls them up to the four ApprovalAction values.
 */
function approvalActionForDriver(
  fromStatus: DriverVerificationStatus,
  toStatus: DriverVerificationStatus,
): ApprovalAction {
  if (toStatus === DriverVerificationStatus.REJECTED) {
    return ApprovalAction.REJECT;
  }
  if (
    toStatus === DriverVerificationStatus.SUSPENDED_ADMIN ||
    toStatus === DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED
  ) {
    return ApprovalAction.SUSPEND;
  }
  if (
    toStatus === DriverVerificationStatus.ACTIVE &&
    (fromStatus === DriverVerificationStatus.SUSPENDED_ADMIN ||
      fromStatus === DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED)
  ) {
    return ApprovalAction.RESUME;
  }
  return ApprovalAction.APPROVE;
}

@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(VehicleAssignment)
    private assignmentRepository: Repository<VehicleAssignment>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    private usersService: UsersService,
    private readonly dataSource: DataSource,
    private readonly approvalsService: ApprovalsService,
    private readonly events: EventEmitter2,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * C5 / D1 — single state-change entry point for driver_profiles.
   * verification_status. Wraps the state-machine assertion + row
   * write + approval_decisions insert in a single transaction so
   * the audit ledger and the live status can never disagree (the
   * canonical ARCH-3 pattern).
   *
   * `caller` is the admin issuing the change; pass `null` for
   * system-driven transitions (cron suspensions, auto-pending on
   * setup completion). The approval_decisions row then records
   * reviewerId=NULL — the documented system sentinel.
   *
   * D1 — chained transition: `pending_approval → approved` auto-
   * promotes to `active` in the same transaction. The audit
   * records ONE row (action=APPROVE) per arch §1.2; the second
   * edge is purely operational state.
   */
  async transitionVerification(
    driverId: string,
    dto: UpdateDriverVerificationDto,
    caller: User | null,
  ): Promise<DriverProfile> {
    const reviewed = await this.dataSource.transaction(async (manager) => {
      const profile = await manager.findOne(DriverProfile, {
        where: { id: driverId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile) {
        throw new NotFoundException(`Driver ${driverId} not found`);
      }

      driverStateMachine.assertTransition(
        profile.verificationStatus,
        dto.status,
        ErrorCodes.DRIVER_002,
      );

      const previousStatus = profile.verificationStatus;
      profile.verificationStatus = dto.status;
      // Suspension / rejection takes the driver offline immediately —
      // can't keep dispatching to someone who just lost their license.
      if (
        dto.status === DriverVerificationStatus.SUSPENDED_ADMIN ||
        dto.status === DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED ||
        dto.status === DriverVerificationStatus.REJECTED
      ) {
        profile.isOnline = false;
      }
      await manager.save(profile);

      await this.approvalsService.recordDecision(manager, {
        targetType: ApprovalTargetType.DRIVER,
        targetId: profile.id,
        action: approvalActionForDriver(previousStatus, dto.status),
        reviewerId: caller?.id ?? null,
        reason: dto.reason,
      });

      // D1 chained transition: approved → active. State machine
      // declares the edge so assertTransition succeeds; we don't
      // write a second audit row (arch §1.2: admin sees one).
      if (
        previousStatus === DriverVerificationStatus.PENDING_APPROVAL &&
        profile.verificationStatus === DriverVerificationStatus.APPROVED
      ) {
        driverStateMachine.assertTransition(
          DriverVerificationStatus.APPROVED,
          DriverVerificationStatus.ACTIVE,
          ErrorCodes.DRIVER_002,
        );
        profile.verificationStatus = DriverVerificationStatus.ACTIVE;
        await manager.save(profile);
      }

      return profile;
    });

    // ARCH-10 push fanout. Emit AFTER the transaction commits — a
    // slow Firebase call can never hold the admin's PATCH open
    // (PushFanoutService is fire-and-forget). The reviewed profile
    // already carries the userId we'd target.
    const reviewEvent =
      dto.status === DriverVerificationStatus.APPROVED
        ? 'driver.approved'
        : dto.status === DriverVerificationStatus.REJECTED
          ? 'driver.rejected'
          : null;
    if (reviewEvent) {
      this.events.emit(reviewEvent, {
        userId: reviewed.userId,
        reason: dto.reason ?? null,
      });
    }

    return reviewed;
  }

  /**
   * D1 — system-driven submit: setup_required → pending_approval.
   * Called when the driver's setup wizard completes (D2). Recorded
   * in approval_decisions with reviewerId=NULL (system sentinel).
   *
   * Idempotent under the lock: if the driver is already in
   * pending_approval (e.g. duplicate wizard submit), the state
   * machine throws DRIVER_002 and the caller can swallow it.
   */
  async submitForApproval(driverId: string): Promise<DriverProfile> {
    return this.transitionVerification(
      driverId,
      { status: DriverVerificationStatus.PENDING_APPROVAL },
      null,
    );
  }

  /**
   * C5 admin queue — list drivers in `pending_approval`. Returned as
   * a flat shape so the admin frontend doesn't have to walk the User
   * relation through JSON envelopes.
   */
  async findPendingForAdmin(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<{ items: DriverProfile[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const [items, total] = await this.driverProfileRepository.findAndCount({
      where: { verificationStatus: DriverVerificationStatus.PENDING_APPROVAL },
      order: { updatedAt: 'DESC' },
      take: limit,
      skip: offset,
      relations: ['user', 'company'],
    });
    return { items, total };
  }

  async createProfile(
    userId: string,
    manager?: EntityManager,
  ): Promise<DriverProfile> {
    // Optional EntityManager so callers (e.g. AuthService during driver
    // registration) can include this insert in their own transaction.
    const repo = manager
      ? manager.getRepository(DriverProfile)
      : this.driverProfileRepository;

    const existingProfile = await repo.findOne({ where: { userId } });

    if (existingProfile) {
      return existingProfile;
    }

    const profile = repo.create({ userId });
    return repo.save(profile);
  }

  async findByUserId(userId: string): Promise<DriverProfile | null> {
    return this.driverProfileRepository.findOne({
      where: { userId },
      relations: ['user'],
    });
  }

  async updateOnlineStatus(
    userId: string,
    isOnline: boolean,
  ): Promise<DriverProfile> {
    let profile = await this.findByUserId(userId);

    if (!profile) {
      // Backfill path: drivers registered before A3 shipped don't have a
      // profile row yet. Auto-create one — but only for users whose role is
      // actually 'driver'. Any other role missing a profile is a genuine
      // 404 and should surface as such.
      const user = await this.usersService.findById(userId);
      if (!user) {
        throw new NotFoundException('Driver profile not found');
      }
      if (user.role !== UserRole.DRIVER) {
        throw new NotFoundException('Driver profile not found');
      }
      profile = await this.createProfile(userId);
    }

    // B5: going online requires an active assignment to an APPROVED
    // vehicle. Going offline is unconditional — drivers must always be
    // able to drop out, even if their assignment is in flux.
    let vehicleForRooms: Vehicle | null = null;
    if (isOnline) {
      vehicleForRooms = await this.assertHasActiveApprovedVehicle(profile.id);
    }

    profile.isOnline = isOnline;
    const saved = await this.driverProfileRepository.save(profile);

    // ARCH-12 — sync the driver's socket subscriptions with the
    // online flip. Gateway lookups use the userId; if the socket
    // isn't connected yet the helper returns []. Synchronous + cheap;
    // any throw inside is swallowed so socket bookkeeping can't 500
    // the HTTP handler.
    this.syncEligibleRooms(userId, isOnline, vehicleForRooms);

    return saved;
  }

  private syncEligibleRooms(
    userId: string,
    isOnline: boolean,
    vehicle: Vehicle | null,
  ): void {
    let gateway: RealtimeGateway | null = null;
    try {
      // The class identity is resolved by Nest at runtime — passing
      // the string 'RealtimeGateway' lets ModuleRef look it up by
      // provider name without us having to import the concrete class
      // (which would re-introduce the drivers ↔ realtime circular dep).
      gateway = this.moduleRef.get<RealtimeGateway>(
        'RealtimeGateway' as unknown as never,
        { strict: false },
      );
    } catch {
      // Gateway not registered (CLI run, isolated unit test). Skip.
      return;
    }
    if (!gateway) return;
    if (!isOnline) {
      gateway.leaveDriverFromEligibleRooms(userId);
      return;
    }
    if (!vehicle) return;
    const sizes = packageSizesForVehicle(vehicle.type);
    gateway.joinDriverToEligibleRooms(userId, sizes);
  }

  /**
   * Throws BadRequestException with DRIVER_003 if the driver has no
   * active assignment OR the assigned vehicle isn't APPROVED.
   */
  private async assertHasActiveApprovedVehicle(
    driverId: string,
  ): Promise<Vehicle> {
    const activeAssignment = await this.assignmentRepository.findOne({
      where: { driverId, unassignedAt: IsNull() },
    });
    if (!activeAssignment) {
      throw new BadRequestException({
        errorCode: ErrorCodes.DRIVER_003,
        message: 'Your assigned vehicle is not currently approved.',
      });
    }
    const vehicle = await this.vehicleRepository.findOne({
      where: { id: activeAssignment.vehicleId },
    });
    if (!vehicle || vehicle.status !== VehicleStatus.APPROVED) {
      throw new BadRequestException({
        errorCode: ErrorCodes.DRIVER_003,
        message: 'Your assigned vehicle is not currently approved.',
      });
    }
    return vehicle;
  }

  /**
   * B5 — order-matching eligibility query.
   *
   * Returns every active (driver, vehicle) pair that matches the four
   * filters from the architecture:
   *
   *   driver_profiles.verification_status = 'active'
   *   driver_profiles.is_online            = true
   *   vehicle_assignments.unassigned_at    IS NULL
   *   vehicles.status                      = 'approved'
   *
   * Multiple drivers can be online simultaneously — there's no implicit
   * "one driver per company" or "one driver per fleet" cap. Order
   * assignment (J4) adds distance / availability filtering on top of
   * this list.
   */
  async findEligibleDrivers(): Promise<EligibleDriver[]> {
    const rows = await this.driverProfileRepository
      .createQueryBuilder('dp')
      .innerJoin(
        VehicleAssignment,
        'va',
        'va."driverId" = dp.id AND va."unassignedAt" IS NULL',
      )
      .innerJoin(
        Vehicle,
        'v',
        'v.id = va."vehicleId" AND v.status = :approved',
        { approved: VehicleStatus.APPROVED },
      )
      .where('dp."verificationStatus" = :active', {
        active: DriverVerificationStatus.ACTIVE,
      })
      .andWhere('dp."isOnline" = true')
      .select([
        'dp.id AS "driverId"',
        'dp."userId" AS "userId"',
        'dp."currentLatitude" AS "currentLatitude"',
        'dp."currentLongitude" AS "currentLongitude"',
        'v.id AS "vehicleId"',
        'v.type AS "vehicleType"',
        'v.plate AS "vehiclePlate"',
        'va.id AS "assignmentId"',
      ])
      .getRawMany<EligibleDriver>();
    return rows;
  }

  async updateLocation(
    userId: string,
    latitude: number,
    longitude: number,
  ): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    profile.currentLatitude = latitude;
    profile.currentLongitude = longitude;

    return this.driverProfileRepository.save(profile);
  }

  async updateDeliveryStatus(
    userId: string,
    isOnDelivery: boolean,
  ): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    profile.isOnDelivery = isOnDelivery;

    if (!isOnDelivery) {
      // Delivery completed
      profile.totalDeliveries += 1;
    }

    return this.driverProfileRepository.save(profile);
  }

  async updateEarnings(userId: string, amount: number): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    const delta = naira(String(amount));
    profile.totalEarnings = profile.totalEarnings.plus(delta) as Naira;
    return this.driverProfileRepository.save(profile);
  }

  async updateRating(userId: string, rating: number): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    const totalScore = Number(profile.rating) * profile.totalRatings + rating;
    profile.totalRatings += 1;
    profile.rating = totalScore / profile.totalRatings;

    return this.driverProfileRepository.save(profile);
  }

  async getStats(userId: string) {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    return {
      totalDeliveries: profile.totalDeliveries,
      rating: Number(profile.rating).toFixed(1),
      totalRatings: profile.totalRatings,
      totalEarnings: profile.totalEarnings.toFixed(2),
      isOnline: profile.isOnline,
      isOnDelivery: profile.isOnDelivery,
    };
  }
}
