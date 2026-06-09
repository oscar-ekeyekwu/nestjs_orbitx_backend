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
  DriverAccountType,
  DriverProfile,
  DriverVerificationStatus,
} from './entities/driver-profile.entity';
import { driverStateMachine } from './driver-state-machine';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import {
  Vehicle,
  VehicleOwnerType,
  VehicleStatus,
} from '../vehicles/entities/vehicle.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { UsersService } from '../users/users.service';
import { Naira, naira } from '../common/money';
import { ErrorCodes } from '../common/constants/error-codes';
import {
  assertInsideLagos,
  assertInsideNigeria,
  isAcceptableLocationAccuracy,
} from '../common/geo';
import { SystemConfigService } from '../config/config.service';
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
    private readonly systemConfig: SystemConfigService,
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
      const isSuspending =
        dto.status === DriverVerificationStatus.SUSPENDED_ADMIN ||
        dto.status === DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED ||
        dto.status === DriverVerificationStatus.REJECTED;
      if (isSuspending) {
        profile.isOnline = false;
      }
      await manager.save(profile);

      if (isSuspending) {
        // Mirror updateOnlineStatus — push the new isOnline=false to
        // the driver's mobile socket so the home toggle flips in
        // real time instead of waiting for a force-quit + cold-start
        // re-hydrate.
        this.events.emit('driver.status', {
          userId: profile.userId,
          isOnline: profile.isOnline,
          isOnDelivery: profile.isOnDelivery,
        });
      }

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

        // Approve the driver's pending individual-driver vehicle in the
        // same transaction. The admin almost always means "this person
        // is ready to drive" — having to click through to a separate
        // Vehicles tab to approve the bike that came with the
        // application is friction we don't need. Company-owned
        // vehicles are NOT auto-approved here — they go through the
        // company queue separately.
        await manager.update(
          Vehicle,
          {
            ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
            ownerId: profile.id,
            status: VehicleStatus.PENDING_APPROVAL,
          },
          {
            status: VehicleStatus.APPROVED,
            approvedAt: new Date(),
            approvedBy: caller?.id ?? null,
          },
        );
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

  /**
   * Snapshot for the admin "Live Drivers" dispatcher view. Returns one
   * row per online driver with their most recent GPS reading, vehicle
   * basics, and (if any) the order they're currently working. The
   * `isOnDelivery` flag is sourced from the driver_profile column —
   * note this is not yet flipped anywhere in the codebase, so the
   * underlying activeOrderId join is the authoritative "is busy"
   * signal until the lifecycle is wired in a later story.
   */
  async findOnlineForAdmin(): Promise<
    Array<{
      userId: string;
      name: string;
      email: string;
      phone: string | null;
      latitude: number | null;
      longitude: number | null;
      lastSeenAt: string;
      isOnDelivery: boolean;
      vehicleType: string | null;
      vehiclePlate: string | null;
      activeOrderId: string | null;
    }>
  > {
    type Row = {
      userId: string;
      first_name: string;
      last_name: string;
      email: string;
      phone: string | null;
      currentLatitude: number | null;
      currentLongitude: number | null;
      isOnDelivery: boolean;
      updatedAt: Date;
      vehicleType: string | null;
      vehiclePlate: string | null;
      activeOrderId: string | null;
    };

    // Single SQL pass:
    //   - driver_profile (filtered to isOnline + verificationStatus=active)
    //   - LEFT JOIN users on userId
    //   - LEFT JOIN vehicles via vehicle_assignments OR ownerId=profile.id
    //   - LEFT JOIN orders for any non-terminal order assigned to the
    //     driver so we can show the activeOrderId.
    const rows = await this.driverProfileRepository.query<Row[]>(`
      SELECT
        dp."userId"                         AS "userId",
        u.first_name                         AS "first_name",
        u.last_name                          AS "last_name",
        u.email                              AS "email",
        u.phone                              AS "phone",
        dp."currentLatitude"                 AS "currentLatitude",
        dp."currentLongitude"                AS "currentLongitude",
        dp."isOnDelivery"                    AS "isOnDelivery",
        dp."updatedAt"                       AS "updatedAt",
        v.type                               AS "vehicleType",
        v.plate                              AS "vehiclePlate",
        o.id                                 AS "activeOrderId"
      FROM driver_profiles dp
      INNER JOIN users u ON u.id = dp."userId"
      LEFT JOIN LATERAL (
        SELECT vh.type, vh.plate
        FROM vehicles vh
        WHERE (
          (vh."ownerType" = 'individual_driver' AND vh."ownerId" = dp.id)
          OR vh.id IN (
            SELECT va."vehicleId"
            FROM vehicle_assignments va
            WHERE va."driverId" = dp."userId"
              AND va."endedAt" IS NULL
          )
        )
        ORDER BY vh."updatedAt" DESC
        LIMIT 1
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT ord.id
        FROM orders ord
        WHERE ord."driverId" = dp."userId"
          AND ord.status IN ('accepted', 'picked_up', 'in_transit')
        ORDER BY ord."updatedAt" DESC
        LIMIT 1
      ) o ON true
      WHERE dp."isOnline" = true
        AND dp."verificationStatus" = 'active'
      ORDER BY dp."updatedAt" DESC
    `);

    return (rows as unknown as Row[]).map((r) => ({
      userId: r.userId,
      name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
      email: r.email,
      phone: r.phone,
      latitude: r.currentLatitude == null ? null : Number(r.currentLatitude),
      longitude: r.currentLongitude == null ? null : Number(r.currentLongitude),
      lastSeenAt: r.updatedAt.toISOString(),
      isOnDelivery: !!r.isOnDelivery || !!r.activeOrderId,
      vehicleType: r.vehicleType,
      vehiclePlate: r.vehiclePlate,
      activeOrderId: r.activeOrderId,
    }));
  }

  async createProfile(
    userId: string,
    manager?: EntityManager,
    accountType?: DriverAccountType,
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

    const profile = repo.create({
      userId,
      ...(accountType ? { accountType } : {}),
    });
    return repo.save(profile);
  }

  async findByUserId(userId: string): Promise<DriverProfile | null> {
    return this.driverProfileRepository.findOne({
      where: { userId },
      relations: ['user'],
    });
  }

  /**
   * Enriched profile fetch used by GET /drivers/profile. Stitches the
   * driver's vehicle onto the row so the mobile profile screen can
   * render type / plate / status without a second round-trip.
   * Internal callers should still use findByUserId — they don't need
   * the join and the extra query would just be ballast.
   */
  async findByUserIdWithVehicle(userId: string): Promise<DriverProfile | null> {
    const profile = await this.findByUserId(userId);
    if (!profile) return profile;
    const vehicle = await this.findDriverVehicle(profile);
    return Object.assign(profile, {
      vehicle: vehicle
        ? {
            id: vehicle.id,
            type: vehicle.type,
            plate: vehicle.plate,
            color: vehicle.color,
            status: vehicle.status,
          }
        : null,
    });
  }

  private async findDriverVehicle(
    profile: DriverProfile,
  ): Promise<Vehicle | null> {
    // Individual drivers: vehicle owner is (INDIVIDUAL_DRIVER, profile.id).
    // Pick the most-recently-created row; in practice a driver has at
    // most one vehicle in this slot until the multi-vehicle story lands.
    const owned = await this.vehicleRepository.findOne({
      where: {
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: profile.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (owned) return owned;
    // Company owners + employees: the wizard creates the vehicle under
    // (COMPANY, profile.companyId) when accountType is company_*. Pick
    // any vehicle from that company so the profile screen still has
    // *something* to show. Multi-vehicle company drivers will need a
    // proper assignment-aware UI in a follow-up.
    if (profile.companyId) {
      const companyVehicle = await this.vehicleRepository.findOne({
        where: {
          ownerType: VehicleOwnerType.COMPANY,
          ownerId: profile.companyId,
        },
        order: { createdAt: 'DESC' },
      });
      if (companyVehicle) return companyVehicle;
    }
    // Last fallback: active VehicleAssignment (a driver moved between
    // companies, or temporarily assigned to a vehicle they don't own).
    const assignment = await this.assignmentRepository.findOne({
      where: { driverId: profile.userId, unassignedAt: IsNull() },
      order: { assignedAt: 'DESC' },
    });
    if (!assignment) return null;
    return this.vehicleRepository.findOne({
      where: { id: assignment.vehicleId },
    });
  }

  async updateOnlineStatus(
    userId: string,
    isOnline: boolean,
    location?: { latitude: number; longitude: number },
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

    // I5 + J2 — when the client supplies a location (or the profile
    // has stored coords from a prior /drivers/location update),
    // assert it falls inside the Nigeria sanity bbox (J2) AND inside
    // the configured Lagos service zone (I5). Pre-v1 mobile clients
    // that don't send coords on the go-online call skip the gate
    // here — they'll get caught at the first location-update tick.
    // Going offline never needs coordinates; drivers must always be
    // able to drop out.
    if (isOnline) {
      const lat = location?.latitude ?? profile.currentLatitude;
      const lng = location?.longitude ?? profile.currentLongitude;
      if (
        lat !== null &&
        lng !== null &&
        lat !== undefined &&
        lng !== undefined
      ) {
        assertInsideNigeria(lat, lng);
        await assertInsideLagos(lat, lng, this.systemConfig);
      }
      if (location) {
        profile.currentLatitude = location.latitude;
        profile.currentLongitude = location.longitude;
      }
    }

    // B5: going online requires an APPROVED vehicle the driver can
    // actually drive. For an individual driver that's a vehicle owned
    // by (INDIVIDUAL_DRIVER, profile.id). For a company owner that's
    // a vehicle owned by (COMPANY, profile.companyId). For a company
    // employee that's an active vehicle_assignments row. Going offline
    // is unconditional — drivers must always be able to drop out.
    let vehicleForRooms: Vehicle | null = null;
    if (isOnline) {
      vehicleForRooms = await this.assertHasActiveApprovedVehicle(profile);
    }

    profile.isOnline = isOnline;
    const saved = await this.driverProfileRepository.save(profile);

    // ARCH-12 — sync the driver's socket subscriptions with the
    // online flip. Gateway lookups use the userId; if the socket
    // isn't connected yet the helper returns []. Synchronous + cheap;
    // any throw inside is swallowed so socket bookkeeping can't 500
    // the HTTP handler.
    this.syncEligibleRooms(userId, isOnline, vehicleForRooms);

    // Decoupled via EventEmitter2 (wallet.funded precedent) so this
    // module never imports RealtimeGateway directly. The gateway's
    // @OnEvent('driver.status') listener forwards to the driver's
    // socket. Lets the mobile UI reconcile across multi-device,
    // admin force-offline, and doc-expiry suspension without polling.
    this.events.emit('driver.status', {
      userId,
      isOnline: saved.isOnline,
      isOnDelivery: saved.isOnDelivery,
    });

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
   * route to an APPROVED vehicle. Three routes are accepted:
   *
   *   1. Individual driver — vehicle owned by (INDIVIDUAL_DRIVER,
   *      profile.id). No vehicle_assignments row needed; the
   *      ownership IS the link.
   *   2. Company owner — vehicle owned by (COMPANY, profile.companyId).
   *      Same direct-ownership pattern, just through the company.
   *   3. Company employee — active vehicle_assignments row on the
   *      driver's userId. This is the original B5 path; it stays
   *      for multi-driver / fleet companies.
   *
   * The vehicle picked from any of those routes must be `APPROVED`.
   */
  private async assertHasActiveApprovedVehicle(
    profile: DriverProfile,
  ): Promise<Vehicle> {
    const candidates: Vehicle[] = [];

    // Route 1 — individual driver direct ownership.
    const owned = await this.vehicleRepository.findOne({
      where: {
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: profile.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (owned) candidates.push(owned);

    // Route 2 — company-owner direct ownership.
    if (profile.companyId) {
      const companyVehicle = await this.vehicleRepository.findOne({
        where: {
          ownerType: VehicleOwnerType.COMPANY,
          ownerId: profile.companyId,
        },
        order: { createdAt: 'DESC' },
      });
      if (companyVehicle) candidates.push(companyVehicle);
    }

    // Route 3 — assigned employee (legacy B5 path).
    const activeAssignment = await this.assignmentRepository.findOne({
      where: { driverId: profile.userId, unassignedAt: IsNull() },
    });
    if (activeAssignment) {
      const assigned = await this.vehicleRepository.findOne({
        where: { id: activeAssignment.vehicleId },
      });
      if (assigned) candidates.push(assigned);
    }

    const approved = candidates.find(
      (v) => v.status === VehicleStatus.APPROVED,
    );
    if (!approved) {
      throw new BadRequestException({
        errorCode: ErrorCodes.DRIVER_003,
        message: 'Your assigned vehicle is not currently approved.',
      });
    }
    return approved;
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
    accuracyMeters?: number | null,
  ): Promise<DriverProfile | null> {
    // J2 — sanity bbox: a reading from outside Nigeria is GPS drift,
    // a fixture leak, or spoofing. Reject with GEO_001 so the client
    // can show a meaningful error instead of silently writing trash.
    assertInsideNigeria(latitude, longitude);

    // J2 / NFR-P3 — accuracy gate. Updates worse than 50m are dropped
    // silently to keep the customer socket clean. We return null so
    // the caller knows nothing was written; the public controller maps
    // null → 204 (no content).
    if (!isAcceptableLocationAccuracy(accuracyMeters)) {
      return null;
    }

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
