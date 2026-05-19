import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import {
  VehiclePendingUpdate,
  VehiclePendingUpdateStatus,
} from './entities/vehicle-pending-update.entity';
import { Vehicle, VehicleType } from './entities/vehicle.entity';

/**
 * F2 — service that owns the lifecycle of staged vehicle edits.
 *
 *   - submitForVehicle  (called by VehiclesService.updateForUser when
 *                       the vehicle is approved + the patch touches a
 *                       regulatory field)
 *   - approve / reject  (admin actions; approve applies proposed
 *                       values to the live vehicle row inside the
 *                       same transaction that flips status)
 *   - findPendingForVehicle / listPending  (queue + lock-mode lookup)
 *
 * The lock vs continue semantics live in OrdersService.acceptOrder
 * which calls hasPendingFor + reads VEHICLE_EDIT_GRACE_MODE.
 */
@Injectable()
export class VehiclePendingUpdatesService {
  constructor(
    @InjectRepository(VehiclePendingUpdate)
    private readonly pendingRepo: Repository<VehiclePendingUpdate>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    private readonly dataSource: DataSource,
    private readonly approvalsService: ApprovalsService,
    private readonly configService: SystemConfigService,
  ) {}

  /**
   * Stage a regulatory edit. Throws ConflictException if a pending
   * row already exists for this vehicle (one-at-a-time invariant).
   * Returns the staged row.
   */
  async submitForVehicle(
    vehicleId: string,
    proposed: { type?: VehicleType; plate?: string },
    submitter: User,
  ): Promise<VehiclePendingUpdate> {
    if (proposed.type === undefined && proposed.plate === undefined) {
      throw new BadRequestException(
        'At least one regulatory field is required.',
      );
    }

    const existing = await this.pendingRepo.findOne({
      where: {
        vehicleId,
        status: VehiclePendingUpdateStatus.PENDING,
      },
    });
    if (existing) {
      throw new ConflictException(
        'A pending edit already exists for this vehicle.',
      );
    }

    const row = this.pendingRepo.create({
      vehicleId,
      proposedType: proposed.type ?? null,
      proposedPlate: proposed.plate ? proposed.plate.toUpperCase() : null,
      submittedBy: submitter.id,
      status: VehiclePendingUpdateStatus.PENDING,
    });
    return this.pendingRepo.save(row);
  }

  /**
   * Lookup used by the order-accept lock gate. Returns true when the
   * vehicle currently has a row in `pending` status.
   */
  async hasPendingFor(vehicleId: string): Promise<boolean> {
    const count = await this.pendingRepo.count({
      where: {
        vehicleId,
        status: VehiclePendingUpdateStatus.PENDING,
      },
    });
    return count > 0;
  }

  /**
   * Admin queue listing — pending rows oldest-first so the queue is
   * FIFO. Paginated for parity with the rest of the approval queues.
   */
  async listPending(options: {
    limit?: number;
    offset?: number;
  }): Promise<{ items: VehiclePendingUpdate[]; total: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const [items, total] = await this.pendingRepo.findAndCount({
      where: { status: VehiclePendingUpdateStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * Admin approval — applies the proposed values to the live vehicle
   * inside a single transaction that also flips the pending row to
   * `approved` and writes the approval_decisions audit entry.
   */
  async approve(
    id: string,
    admin: User,
    reason?: string,
  ): Promise<VehiclePendingUpdate> {
    this.assertAdmin(admin);

    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockPending(manager, id);
      const vehicle = await manager.findOne(Vehicle, {
        where: { id: row.vehicleId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!vehicle) {
        throw new NotFoundException(`Vehicle ${row.vehicleId} not found`);
      }

      if (row.proposedType !== null) vehicle.type = row.proposedType;
      if (row.proposedPlate !== null) vehicle.plate = row.proposedPlate;
      await manager.save(vehicle);

      row.status = VehiclePendingUpdateStatus.APPROVED;
      row.reviewedBy = admin.id;
      row.reviewedAt = new Date();
      row.reviewReason = reason ?? null;
      await manager.save(row);

      await this.approvalsService.recordDecision(manager, {
        targetType: ApprovalTargetType.VEHICLE,
        targetId: row.vehicleId,
        action: ApprovalAction.APPROVE,
        reviewerId: admin.id,
        reason: reason ?? null,
      });

      return row;
    });
  }

  /**
   * Admin rejection — marks the pending row as rejected. Production
   * vehicle row is untouched. An approval_decisions row is still
   * written so the action shows up in the audit trail.
   */
  async reject(
    id: string,
    admin: User,
    reason: string,
  ): Promise<VehiclePendingUpdate> {
    this.assertAdmin(admin);
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A rejection reason is required.');
    }

    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockPending(manager, id);

      row.status = VehiclePendingUpdateStatus.REJECTED;
      row.reviewedBy = admin.id;
      row.reviewedAt = new Date();
      row.reviewReason = reason;
      await manager.save(row);

      await this.approvalsService.recordDecision(manager, {
        targetType: ApprovalTargetType.VEHICLE,
        targetId: row.vehicleId,
        action: ApprovalAction.REJECT,
        reviewerId: admin.id,
        reason,
      });

      return row;
    });
  }

  /**
   * VEHICLE_EDIT_GRACE_MODE lookup — exposed so callers can branch
   * without duplicating the config read.
   */
  async getGraceMode(): Promise<'continue' | 'lock'> {
    const raw = await this.configService.getString(
      ConfigKey.VEHICLE_EDIT_GRACE_MODE,
      'continue',
    );
    return raw === 'lock' ? 'lock' : 'continue';
  }

  /**
   * Used by OrdersService.acceptOrder: returns the error-code string
   * that should be thrown when a pending edit blocks acceptance under
   * lock mode, or null when the driver can proceed.
   */
  async checkAcceptanceBlock(vehicleId: string): Promise<string | null> {
    const mode = await this.getGraceMode();
    if (mode !== 'lock') return null;
    const blocked = await this.hasPendingFor(vehicleId);
    return blocked ? ErrorCodes.VEHICLE_002 : null;
  }

  private async lockPending(
    manager: EntityManager,
    id: string,
  ): Promise<VehiclePendingUpdate> {
    const row = await manager.findOne(VehiclePendingUpdate, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row) {
      throw new NotFoundException(`Pending update ${id} not found`);
    }
    if (row.status !== VehiclePendingUpdateStatus.PENDING) {
      throw new BadRequestException(
        'Pending update is already resolved and cannot change state.',
      );
    }
    return row;
  }

  private assertAdmin(caller: User): void {
    if (caller.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin role required.');
    }
  }
}
