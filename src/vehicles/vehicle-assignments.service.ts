import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { VehicleAssignment } from './entities/vehicle-assignment.entity';
import {
  Vehicle,
  VehicleOwnerType,
  VehicleStatus,
} from './entities/vehicle.entity';
import { Company, CompanyStatus } from '../companies/entities/company.entity';
import { CompanyMembershipsService } from '../companies/company-memberships.service';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { CreateVehicleAssignmentDto } from './dto/create-vehicle-assignment.dto';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

const PG_UNIQUE_VIOLATION = '23505';

interface PgDriverError {
  code?: string;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { driverError?: PgDriverError; code?: string };
  return (
    (candidate.driverError?.code ?? candidate.code) === PG_UNIQUE_VIOLATION
  );
}

@Injectable()
export class VehicleAssignmentsService {
  constructor(
    @InjectRepository(VehicleAssignment)
    private readonly assignmentRepo: Repository<VehicleAssignment>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(DriverProfile)
    private readonly driverProfileRepo: Repository<DriverProfile>,
    private readonly memberships: CompanyMembershipsService,
  ) {}

  /**
   * Assign a driver to a vehicle. Authorization:
   *
   *   - admins assign anywhere
   *   - company owners assign WITHIN their company (driver must be an
   *     approved member; vehicle must be company-owned + approved)
   *
   * The DB's unique partial index on `vehicle_id WHERE unassigned_at
   * IS NULL` enforces "one active driver per vehicle". A duplicate
   * surfaces as a Postgres 23505 here, which we translate into a
   * 409 / ASSIGNMENT_001 so callers don't get the raw constraint
   * name on the wire.
   */
  async assign(
    dto: CreateVehicleAssignmentDto,
    caller: User,
  ): Promise<VehicleAssignment> {
    const vehicle = await this.vehicleRepo.findOne({
      where: { id: dto.vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${dto.vehicleId} not found`);
    }
    if (vehicle.status !== VehicleStatus.APPROVED) {
      throw new BadRequestException(
        `Vehicle must be approved before assignment (current status: ${vehicle.status}).`,
      );
    }

    const driver = await this.driverProfileRepo.findOne({
      where: { id: dto.driverId },
    });
    if (!driver) {
      throw new NotFoundException(`Driver ${dto.driverId} not found`);
    }

    if (caller.role !== UserRole.ADMIN) {
      // Non-admin path: caller must be the company owner of a
      // company-owned vehicle, and the driver must be an approved
      // member of that company.
      if (vehicle.ownerType !== VehicleOwnerType.COMPANY) {
        throw new ForbiddenException(
          'Only the owner of a company-owned vehicle can assign drivers.',
        );
      }
      const company = await this.companyRepo.findOne({
        where: { id: vehicle.ownerId },
      });
      if (!company) {
        throw new NotFoundException(
          `Owning company ${vehicle.ownerId} not found`,
        );
      }
      if (company.createdBy !== caller.id) {
        throw new ForbiddenException(
          'You can only manage assignments within your own company.',
        );
      }
      if (company.status !== CompanyStatus.APPROVED) {
        throw new BadRequestException(
          'Company must be approved before assigning vehicles.',
        );
      }
      const isMember = await this.memberships.isApprovedMember(
        driver.id,
        company.id,
      );
      if (!isMember) {
        throw new BadRequestException({
          errorCode: ErrorCodes.MEMBERSHIP_001,
          message:
            'Driver is not an approved member of your company. Invite them via company memberships first.',
        });
      }
    }

    const assignment = this.assignmentRepo.create({
      driverId: dto.driverId,
      vehicleId: dto.vehicleId,
      assignedAt: new Date(),
      unassignedAt: null,
    });

    try {
      return await this.assignmentRepo.save(assignment);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          errorCode: ErrorCodes.ASSIGNMENT_001,
          message:
            'This vehicle already has an active driver. Unassign the current driver first.',
        });
      }
      throw err;
    }
  }

  /**
   * Soft-unassign: set unassigned_at = now(). The row is preserved
   * so historical "who drove what" queries still work, and the unique
   * partial index frees the (vehicle) slot for a fresh assignment.
   */
  async unassign(id: string, caller: User): Promise<VehicleAssignment> {
    const assignment = await this.assignmentRepo.findOne({
      where: { id },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${id} not found`);
    }
    if (assignment.unassignedAt !== null) {
      throw new BadRequestException('Assignment is already inactive.');
    }
    await this.assertCallerCanManage(assignment.vehicleId, caller);

    assignment.unassignedAt = new Date();
    return this.assignmentRepo.save(assignment);
  }

  /**
   * List assignments. Admins see all; non-admin scopes to assignments
   * on vehicles owned by their company.
   */
  async findAll(opts: {
    caller: User;
    vehicleId?: string;
    driverId?: string;
    activeOnly?: boolean;
  }): Promise<VehicleAssignment[]> {
    const where: Record<string, unknown> = {};
    if (opts.vehicleId) where.vehicleId = opts.vehicleId;
    if (opts.driverId) where.driverId = opts.driverId;
    if (opts.activeOnly) where.unassignedAt = IsNull();

    const all = await this.assignmentRepo.find({
      where,
      order: { assignedAt: 'DESC' },
    });

    if (opts.caller.role === UserRole.ADMIN) return all;

    // Scope to vehicles owned by the caller's company. Resolve via the
    // owning company's createdBy (v1 single-owner model).
    const profile = await this.driverProfileRepo.findOne({
      where: { userId: opts.caller.id },
    });
    if (!profile?.companyId) {
      return [];
    }
    const vehicles = await this.vehicleRepo.find({
      where: {
        ownerType: VehicleOwnerType.COMPANY,
        ownerId: profile.companyId,
      },
    });
    const allowedVehicleIds = new Set(vehicles.map((v) => v.id));
    return all.filter((a) => allowedVehicleIds.has(a.vehicleId));
  }

  private async assertCallerCanManage(
    vehicleId: string,
    caller: User,
  ): Promise<void> {
    if (caller.role === UserRole.ADMIN) return;
    const vehicle = await this.vehicleRepo.findOne({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }
    if (vehicle.ownerType !== VehicleOwnerType.COMPANY) {
      throw new ForbiddenException(
        'Only the owner of a company-owned vehicle can manage its assignments.',
      );
    }
    const company = await this.companyRepo.findOne({
      where: { id: vehicle.ownerId },
    });
    if (!company || company.createdBy !== caller.id) {
      throw new ForbiddenException(
        'You can only manage assignments within your own company.',
      );
    }
  }
}
