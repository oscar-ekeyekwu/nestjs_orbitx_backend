import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  Vehicle,
  VehicleOwnerType,
  VehicleStatus,
} from './entities/vehicle.entity';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import {
  DriverAccountType,
  DriverProfile,
} from '../drivers/entities/driver-profile.entity';
import { vehicleStateMachine } from './vehicle-state-machine';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleStatusDto } from './dto/update-vehicle-status.dto';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

/**
 * Wire-shape returned to clients. The polymorphic owner reference is
 * nested under `owner` (per B3 AC) so admin/mobile consumers don't have
 * to reconstruct it from two flat columns — and we keep the option to
 * swap the underlying storage shape later without breaking the wire.
 */
export interface VehicleResponse {
  id: string;
  type: string;
  plate: string;
  color: string | null;
  photoUrl: string | null;
  status: VehicleStatus;
  owner: { type: VehicleOwnerType; id: string };
  approvedAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toVehicleResponse(v: Vehicle): VehicleResponse {
  return {
    id: v.id,
    type: v.type,
    plate: v.plate,
    color: v.color,
    photoUrl: v.photoUrl,
    status: v.status,
    owner: { type: v.ownerType, id: v.ownerId },
    approvedAt: v.approvedAt,
    approvedBy: v.approvedBy,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function approvalActionFor(
  from: VehicleStatus,
  to: VehicleStatus,
): ApprovalAction {
  if (to === VehicleStatus.APPROVED) {
    return from === VehicleStatus.PENDING_APPROVAL
      ? ApprovalAction.APPROVE
      : ApprovalAction.RESUME;
  }
  if (to === VehicleStatus.REJECTED) return ApprovalAction.REJECT;
  if (to === VehicleStatus.SUSPENDED) return ApprovalAction.SUSPEND;
  if (to === VehicleStatus.ACTIVE) return ApprovalAction.RESUME;
  // RETIRED — modelled as a SUSPEND in the audit ledger; the row's
  // status carries the actual end state. There is no dedicated
  // ApprovalAction.RETIRE in v1.
  return ApprovalAction.SUSPEND;
}

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    @InjectRepository(DriverProfile)
    private readonly driverProfileRepo: Repository<DriverProfile>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a vehicle in DRAFT. Ownership is inferred from the caller's
   * driver_profile:
   *   - individual           → owner_type=individual_driver, owner_id=profile.id
   *   - company_owner        → owner_type=company,           owner_id=profile.companyId
   *   - company_employee     → rejected (employees drive, they don't register)
   */
  async create(dto: CreateVehicleDto, caller: User): Promise<Vehicle> {
    const profile = await this.driverProfileRepo.findOne({
      where: { userId: caller.id },
    });
    if (!profile) {
      throw new ForbiddenException(
        'You need a driver profile to register a vehicle.',
      );
    }

    let ownerType: VehicleOwnerType;
    let ownerId: string;
    switch (profile.accountType) {
      case DriverAccountType.INDIVIDUAL:
        ownerType = VehicleOwnerType.INDIVIDUAL_DRIVER;
        ownerId = profile.id;
        break;
      case DriverAccountType.COMPANY_OWNER:
        if (!profile.companyId) {
          throw new BadRequestException(
            'Company owners must be linked to a company before registering vehicles.',
          );
        }
        ownerType = VehicleOwnerType.COMPANY;
        ownerId = profile.companyId;
        break;
      case DriverAccountType.COMPANY_EMPLOYEE:
        throw new ForbiddenException(
          'Company employees cannot register vehicles. Ask your company owner.',
        );
    }

    const vehicle = this.vehicleRepo.create({
      type: dto.type,
      plate: dto.plate.toUpperCase(),
      color: dto.color ?? null,
      photoUrl: dto.photoUrl ?? null,
      status: VehicleStatus.DRAFT,
      ownerType,
      ownerId,
    });
    return this.vehicleRepo.save(vehicle);
  }

  async findById(id: string): Promise<Vehicle> {
    const vehicle = await this.vehicleRepo.findOne({ where: { id } });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
    return vehicle;
  }

  /** Admin sees any vehicle; non-admin only sees ones their profile owns. */
  async findByIdForUser(id: string, caller: User): Promise<Vehicle> {
    const vehicle = await this.findById(id);
    if (caller.role === UserRole.ADMIN) return vehicle;

    const profile = await this.driverProfileRepo.findOne({
      where: { userId: caller.id },
    });
    if (!profile) {
      throw new ForbiddenException('Driver profile required.');
    }
    const ownsAsIndividual =
      vehicle.ownerType === VehicleOwnerType.INDIVIDUAL_DRIVER &&
      vehicle.ownerId === profile.id;
    const ownsViaCompany =
      vehicle.ownerType === VehicleOwnerType.COMPANY &&
      vehicle.ownerId === profile.companyId;
    if (!ownsAsIndividual && !ownsViaCompany) {
      throw new ForbiddenException('You can only view your own vehicles.');
    }
    return vehicle;
  }

  /** Admin-only paginated listing. */
  async findAll(opts?: {
    status?: VehicleStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Vehicle[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const [items, total] = await this.vehicleRepo.findAndCount({
      where: opts?.status ? { status: opts.status } : undefined,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * Owner self-service transition `draft → pending_approval`. Validated
   * against vehicleStateMachine like every other transition, but no
   * approval_decisions row is written: the audit ledger is for admin
   * actions, not user-initiated submissions.
   */
  async submitForApproval(id: string, caller: User): Promise<Vehicle> {
    return this.dataSource.transaction(async (manager) => {
      const vehicle = await manager.findOne(Vehicle, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!vehicle) {
        throw new NotFoundException(`Vehicle ${id} not found`);
      }

      const profile = await manager.findOne(DriverProfile, {
        where: { userId: caller.id },
      });
      if (!profile) {
        throw new ForbiddenException('Driver profile required.');
      }
      const owns =
        (vehicle.ownerType === VehicleOwnerType.INDIVIDUAL_DRIVER &&
          vehicle.ownerId === profile.id) ||
        (vehicle.ownerType === VehicleOwnerType.COMPANY &&
          vehicle.ownerId === profile.companyId);
      if (!owns) {
        throw new ForbiddenException(
          'You can only submit your own vehicles for approval.',
        );
      }

      vehicleStateMachine.assertTransition(
        vehicle.status,
        VehicleStatus.PENDING_APPROVAL,
        ErrorCodes.VEHICLE_001,
      );

      vehicle.status = VehicleStatus.PENDING_APPROVAL;
      await manager.save(vehicle);

      // ARCH-10 will replace this with a real event emit. For now a
      // structured log line keeps the contract visible to ops and is
      // trivially greppable when the fanout service comes online.
      this.logger.log(
        `event:vehicle.submitted_for_approval id=${vehicle.id} owner=${vehicle.ownerType}:${vehicle.ownerId}`,
      );

      return vehicle;
    });
  }

  /**
   * Admin transition + audit. Sets approved_at / approved_by on the
   * approval edge so consumers can render "Approved on X by Y" without
   * a join through approval_decisions.
   */
  async transitionStatus(
    id: string,
    dto: UpdateVehicleStatusDto,
    caller: User,
  ): Promise<Vehicle> {
    return this.dataSource.transaction(async (manager) => {
      const vehicle = await manager.findOne(Vehicle, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!vehicle) {
        throw new NotFoundException(`Vehicle ${id} not found`);
      }

      vehicleStateMachine.assertTransition(
        vehicle.status,
        dto.status,
        ErrorCodes.VEHICLE_001,
      );

      const previousStatus = vehicle.status;
      vehicle.status = dto.status;
      if (dto.status === VehicleStatus.APPROVED) {
        vehicle.approvedAt = new Date();
        vehicle.approvedBy = caller.id;
      }
      await manager.save(vehicle);

      await manager.insert(ApprovalDecision, {
        targetType: ApprovalTargetType.VEHICLE,
        targetId: vehicle.id,
        action: approvalActionFor(previousStatus, dto.status),
        reviewerId: caller.id,
        reason: dto.reason ?? null,
      });

      return vehicle;
    });
  }
}
