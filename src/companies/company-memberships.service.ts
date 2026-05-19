import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CompanyMembership,
  CompanyMembershipRole,
  CompanyMembershipStatus,
} from './entities/company-membership.entity';
import { Company, CompanyStatus } from './entities/company.entity';
import {
  DriverAccountType,
  DriverProfile,
} from '../drivers/entities/driver-profile.entity';
import { CreateCompanyMembershipDto } from './dto/create-company-membership.dto';
import { UpdateCompanyMembershipStatusDto } from './dto/update-company-membership-status.dto';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

@Injectable()
export class CompanyMembershipsService {
  constructor(
    @InjectRepository(CompanyMembership)
    private readonly membershipRepo: Repository<CompanyMembership>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(DriverProfile)
    private readonly driverProfileRepo: Repository<DriverProfile>,
  ) {}

  /**
   * Invite a driver to a company. Caller must be the company's
   * owner (or admin). Membership lands in `pending` until the driver
   * (or admin) approves it via updateStatus.
   */
  async create(
    companyId: string,
    dto: CreateCompanyMembershipDto,
    caller: User,
  ): Promise<CompanyMembership> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    await this.assertCallerIsOwnerOrAdmin(company, caller);

    // Block invitations from suspended companies — the owner needs to
    // be cleared by admin before they can grow their roster again.
    if (
      company.status === CompanyStatus.SUSPENDED &&
      caller.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Suspended companies cannot invite new drivers until the suspension is lifted.',
      );
    }

    const driverProfile = await this.driverProfileRepo.findOne({
      where: { id: dto.driverId },
    });
    if (!driverProfile) {
      throw new NotFoundException(`Driver profile ${dto.driverId} not found`);
    }

    // One active membership per (driver, company). Re-inviting a
    // previously-removed driver writes a fresh pending row.
    const existing = await this.membershipRepo.findOne({
      where: {
        driverId: dto.driverId,
        companyId,
        status: CompanyMembershipStatus.APPROVED,
      },
    });
    if (existing) {
      throw new BadRequestException(
        'Driver is already an approved member of this company.',
      );
    }

    const role = dto.role ?? CompanyMembershipRole.EMPLOYEE;
    // Only admins can grant the OWNER role; B4 spec says owners are
    // promoted by admin, not self-elected.
    if (
      role === CompanyMembershipRole.OWNER &&
      caller.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('Only admins can grant the owner role.');
    }

    const membership = this.membershipRepo.create({
      driverId: dto.driverId,
      companyId,
      role,
      status: CompanyMembershipStatus.PENDING,
    });
    return this.membershipRepo.save(membership);
  }

  /** List a company's memberships. Admins see any; owners see their own. */
  async findAllForCompany(
    companyId: string,
    caller: User,
  ): Promise<CompanyMembership[]> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    await this.assertCallerIsOwnerOrAdmin(company, caller);

    return this.membershipRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Transition a membership's status. Limited graph:
   *   pending  → approved | removed
   *   approved → removed
   *
   * No re-promotion in v1; create a new membership instead.
   */
  async updateStatus(
    companyId: string,
    membershipId: string,
    dto: UpdateCompanyMembershipStatusDto,
    caller: User,
  ): Promise<CompanyMembership> {
    const membership = await this.membershipRepo.findOne({
      where: { id: membershipId, companyId },
    });
    if (!membership) {
      throw new NotFoundException(`Membership ${membershipId} not found`);
    }
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    await this.assertCallerIsOwnerOrAdmin(company, caller);

    const legal =
      (membership.status === CompanyMembershipStatus.PENDING &&
        (dto.status === CompanyMembershipStatus.APPROVED ||
          dto.status === CompanyMembershipStatus.REMOVED)) ||
      (membership.status === CompanyMembershipStatus.APPROVED &&
        dto.status === CompanyMembershipStatus.REMOVED);
    if (!legal) {
      throw new BadRequestException(
        `Invalid membership transition: ${membership.status} → ${dto.status}`,
      );
    }

    membership.status = dto.status;
    return this.membershipRepo.save(membership);
  }

  /**
   * Helper: is the given driver an APPROVED member of the given company?
   * Used by VehicleAssignmentsService before letting an owner assign
   * vehicles to a driver.
   */
  async isApprovedMember(
    driverId: string,
    companyId: string,
  ): Promise<boolean> {
    const count = await this.membershipRepo.count({
      where: {
        driverId,
        companyId,
        status: CompanyMembershipStatus.APPROVED,
      },
    });
    return count > 0;
  }

  private async assertCallerIsOwnerOrAdmin(
    company: Company,
    caller: User,
  ): Promise<void> {
    if (caller.role === UserRole.ADMIN) return;

    // Owner == the user who created the company. v1 ships with single
    // ownership; v2 will resolve via memberships with role=owner.
    if (company.createdBy === caller.id) return;

    // Also accept a driver whose membership in this company is
    // role=owner + status=approved (forward-compat with promoted owners).
    const profile = await this.driverProfileRepo.findOne({
      where: { userId: caller.id },
    });
    if (profile && profile.accountType === DriverAccountType.COMPANY_OWNER) {
      const ownerMembership = await this.membershipRepo.findOne({
        where: {
          driverId: profile.id,
          companyId: company.id,
          role: CompanyMembershipRole.OWNER,
          status: CompanyMembershipStatus.APPROVED,
        },
      });
      if (ownerMembership) return;
    }

    throw new ForbiddenException(
      'Only the company owner or an admin can manage memberships.',
    );
  }
}
