import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { CompanyMembershipsService } from './company-memberships.service';
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
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

const ADMIN: User = {
  id: 'admin-1',
  email: 'admin@orbitx.com',
  role: UserRole.ADMIN,
} as unknown as User;
const OWNER: User = {
  id: 'owner-1',
  email: 'mrs.adebayo@example.com',
  role: UserRole.DRIVER,
} as unknown as User;
const STRANGER: User = {
  id: 'someone-else',
  email: 'x@example.com',
  role: UserRole.DRIVER,
} as unknown as User;

function buildCompany(overrides: Partial<Company>): Company {
  return {
    id: 'company-1',
    legalName: 'Adebayo Logistics',
    status: CompanyStatus.APPROVED,
    createdBy: OWNER.id,
    cacNumber: null,
    tin: null,
    address: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Company;
}

function buildDriverProfile(overrides: Partial<DriverProfile>): DriverProfile {
  return {
    id: 'driver-1',
    userId: 'user-1',
    accountType: DriverAccountType.INDIVIDUAL,
    companyId: null,
    ...overrides,
  } as unknown as DriverProfile;
}

describe('CompanyMembershipsService (B4)', () => {
  let service: CompanyMembershipsService;
  let membershipRepo: jest.Mocked<Repository<CompanyMembership>>;
  let companyRepo: jest.Mocked<Repository<Company>>;
  let driverProfileRepo: jest.Mocked<Repository<DriverProfile>>;

  beforeEach(() => {
    membershipRepo = {
      create: jest.fn(
        (dto: Partial<CompanyMembership>) =>
          ({ ...dto, id: 'membership-1' }) as CompanyMembership,
      ),
      save: jest.fn((m: CompanyMembership) => Promise.resolve(m)),
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
    } as unknown as jest.Mocked<Repository<CompanyMembership>>;
    companyRepo = { findOne: jest.fn() } as unknown as jest.Mocked<
      Repository<Company>
    >;
    driverProfileRepo = { findOne: jest.fn() } as unknown as jest.Mocked<
      Repository<DriverProfile>
    >;

    service = new CompanyMembershipsService(
      membershipRepo,
      companyRepo,
      driverProfileRepo,
    );
  });

  describe('create', () => {
    it('owner invites an employee — membership lands as pending/employee', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      membershipRepo.findOne.mockResolvedValue(null);

      const result = await service.create(
        'company-1',
        { driverId: 'driver-1' },
        OWNER,
      );

      expect(result.status).toBe(CompanyMembershipStatus.PENDING);
      expect(result.role).toBe(CompanyMembershipRole.EMPLOYEE);
      expect(result.companyId).toBe('company-1');
      expect(result.driverId).toBe('driver-1');
    });

    it('rejects a non-owner stranger with 403', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      driverProfileRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create('company-1', { driverId: 'driver-1' }, STRANGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when the company is suspended (non-admin path)', async () => {
      companyRepo.findOne.mockResolvedValue(
        buildCompany({ status: CompanyStatus.SUSPENDED }),
      );

      await expect(
        service.create('company-1', { driverId: 'driver-1' }, OWNER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects re-invite when an approved membership already exists', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      membershipRepo.findOne.mockResolvedValue({
        id: 'existing',
        status: CompanyMembershipStatus.APPROVED,
      } as unknown as CompanyMembership);

      await expect(
        service.create('company-1', { driverId: 'driver-1' }, OWNER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('owner cannot grant the OWNER role to another driver (403)', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      membershipRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          'company-1',
          { driverId: 'driver-1', role: CompanyMembershipRole.OWNER },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin CAN grant the OWNER role', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      membershipRepo.findOne.mockResolvedValue(null);

      const result = await service.create(
        'company-1',
        { driverId: 'driver-1', role: CompanyMembershipRole.OWNER },
        ADMIN,
      );
      expect(result.role).toBe(CompanyMembershipRole.OWNER);
    });
  });

  describe('updateStatus — legal transitions', () => {
    const legal: Array<[CompanyMembershipStatus, CompanyMembershipStatus]> = [
      [CompanyMembershipStatus.PENDING, CompanyMembershipStatus.APPROVED],
      [CompanyMembershipStatus.PENDING, CompanyMembershipStatus.REMOVED],
      [CompanyMembershipStatus.APPROVED, CompanyMembershipStatus.REMOVED],
    ];

    it.each(legal)('%s → %s is allowed', async (from, to) => {
      membershipRepo.findOne.mockResolvedValue({
        id: 'membership-1',
        companyId: 'company-1',
        driverId: 'driver-1',
        role: CompanyMembershipRole.EMPLOYEE,
        status: from,
      } as unknown as CompanyMembership);
      companyRepo.findOne.mockResolvedValue(buildCompany({}));

      const result = await service.updateStatus(
        'company-1',
        'membership-1',
        { status: to },
        OWNER,
      );
      expect(result.status).toBe(to);
    });

    it('rejects approved → pending (illegal regression)', async () => {
      membershipRepo.findOne.mockResolvedValue({
        id: 'membership-1',
        companyId: 'company-1',
        driverId: 'driver-1',
        status: CompanyMembershipStatus.APPROVED,
      } as unknown as CompanyMembership);
      companyRepo.findOne.mockResolvedValue(buildCompany({}));

      await expect(
        service.updateStatus(
          'company-1',
          'membership-1',
          { status: CompanyMembershipStatus.PENDING },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects removed → approved (re-add via new invite, not update)', async () => {
      membershipRepo.findOne.mockResolvedValue({
        id: 'membership-1',
        companyId: 'company-1',
        driverId: 'driver-1',
        status: CompanyMembershipStatus.REMOVED,
      } as unknown as CompanyMembership);
      companyRepo.findOne.mockResolvedValue(buildCompany({}));

      await expect(
        service.updateStatus(
          'company-1',
          'membership-1',
          { status: CompanyMembershipStatus.APPROVED },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('isApprovedMember', () => {
    it('returns true when an approved row exists', async () => {
      membershipRepo.count.mockResolvedValue(1);
      expect(await service.isApprovedMember('driver-1', 'company-1')).toBe(
        true,
      );
    });

    it('returns false when no approved row exists', async () => {
      membershipRepo.count.mockResolvedValue(0);
      expect(await service.isApprovedMember('driver-1', 'company-1')).toBe(
        false,
      );
    });
  });

  describe('findAllForCompany', () => {
    it('returns memberships when caller is owner', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      membershipRepo.find.mockResolvedValue([
        { id: 'm1' } as unknown as CompanyMembership,
        { id: 'm2' } as unknown as CompanyMembership,
      ]);

      const result = await service.findAllForCompany('company-1', OWNER);
      expect(result).toHaveLength(2);
    });

    it('rejects stranger with 403', async () => {
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      driverProfileRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findAllForCompany('company-1', STRANGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 when the company does not exist', async () => {
      companyRepo.findOne.mockResolvedValue(null);
      await expect(
        service.findAllForCompany('missing', OWNER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
