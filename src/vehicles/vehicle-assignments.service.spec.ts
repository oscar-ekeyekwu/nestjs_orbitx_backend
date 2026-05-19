/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { VehicleAssignmentsService } from './vehicle-assignments.service';
import { VehicleAssignment } from './entities/vehicle-assignment.entity';
import {
  Vehicle,
  VehicleOwnerType,
  VehicleStatus,
  VehicleType,
} from './entities/vehicle.entity';
import { Company, CompanyStatus } from '../companies/entities/company.entity';
import {
  DriverAccountType,
  DriverProfile,
} from '../drivers/entities/driver-profile.entity';
import { CompanyMembershipsService } from '../companies/company-memberships.service';
import { ErrorCodes } from '../common/constants/error-codes';
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
  email: 'someone@example.com',
  role: UserRole.DRIVER,
} as unknown as User;

function buildVehicle(overrides: Partial<Vehicle>): Vehicle {
  return {
    id: 'vehicle-1',
    type: VehicleType.VAN,
    plate: 'LAG-100-ZZ',
    color: 'White',
    photoUrl: null,
    status: VehicleStatus.APPROVED,
    ownerType: VehicleOwnerType.COMPANY,
    ownerId: 'company-1',
    approvedAt: new Date('2026-05-17T00:00:00Z'),
    approvedBy: 'admin-1',
    createdAt: new Date('2026-05-17T00:00:00Z'),
    updatedAt: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  } as unknown as Vehicle;
}

function buildCompany(overrides: Partial<Company>): Company {
  return {
    id: 'company-1',
    legalName: 'Adebayo Logistics',
    cacNumber: null,
    tin: null,
    address: null,
    status: CompanyStatus.APPROVED,
    createdBy: OWNER.id,
    createdAt: new Date('2026-05-17T00:00:00Z'),
    updatedAt: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  } as unknown as Company;
}

function buildDriverProfile(overrides: Partial<DriverProfile>): DriverProfile {
  return {
    id: 'driver-1',
    userId: 'user-1',
    accountType: DriverAccountType.COMPANY_EMPLOYEE,
    companyId: 'company-1',
    ...overrides,
  } as unknown as DriverProfile;
}

describe('VehicleAssignmentsService (B4)', () => {
  let service: VehicleAssignmentsService;
  let assignmentRepo: jest.Mocked<Repository<VehicleAssignment>>;
  let vehicleRepo: jest.Mocked<Repository<Vehicle>>;
  let companyRepo: jest.Mocked<Repository<Company>>;
  let driverProfileRepo: jest.Mocked<Repository<DriverProfile>>;
  let memberships: jest.Mocked<CompanyMembershipsService>;

  beforeEach(() => {
    assignmentRepo = {
      create: jest.fn(
        (dto: Partial<VehicleAssignment>) =>
          ({ ...dto, id: 'assignment-1' }) as VehicleAssignment,
      ),
      save: jest.fn((a: VehicleAssignment) => Promise.resolve(a)),
      findOne: jest.fn(),
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<VehicleAssignment>>;
    vehicleRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<Vehicle>>;
    companyRepo = { findOne: jest.fn() } as unknown as jest.Mocked<
      Repository<Company>
    >;
    driverProfileRepo = { findOne: jest.fn() } as unknown as jest.Mocked<
      Repository<DriverProfile>
    >;
    memberships = {
      isApprovedMember: jest.fn(),
    } as unknown as jest.Mocked<CompanyMembershipsService>;

    service = new VehicleAssignmentsService(
      assignmentRepo,
      vehicleRepo,
      companyRepo,
      driverProfileRepo,
      memberships,
    );
  });

  describe('assign — happy path', () => {
    it('owner assigns an approved member to an approved company vehicle', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      memberships.isApprovedMember.mockResolvedValue(true);

      const result = await service.assign(
        { driverId: 'driver-1', vehicleId: 'vehicle-1' },
        OWNER,
      );

      expect(result.driverId).toBe('driver-1');
      expect(result.vehicleId).toBe('vehicle-1');
      expect(result.unassignedAt).toBeNull();
      expect(result.assignedAt).toBeInstanceOf(Date);
    });

    it('admin can assign across any company without owner check', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));

      const result = await service.assign(
        { driverId: 'driver-1', vehicleId: 'vehicle-1' },
        ADMIN,
      );

      expect(result.vehicleId).toBe('vehicle-1');
      // Admin path doesn't consult memberships.
      expect(memberships.isApprovedMember).not.toHaveBeenCalled();
    });
  });

  describe('assign — authorization', () => {
    it('rejects a non-owner stranger with 403', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      companyRepo.findOne.mockResolvedValue(buildCompany({}));

      await expect(
        service.assign(
          { driverId: 'driver-1', vehicleId: 'vehicle-1' },
          STRANGER,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an individual-owned vehicle for company-owner caller (403)', async () => {
      vehicleRepo.findOne.mockResolvedValue(
        buildVehicle({
          ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
          ownerId: 'other-driver',
        }),
      );
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));

      await expect(
        service.assign({ driverId: 'driver-1', vehicleId: 'vehicle-1' }, OWNER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects with MEMBERSHIP_001 when driver is not an approved member', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      memberships.isApprovedMember.mockResolvedValue(false);

      let caught: unknown;
      try {
        await service.assign(
          { driverId: 'driver-1', vehicleId: 'vehicle-1' },
          OWNER,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errorCode: string;
      };
      expect(response.errorCode).toBe(ErrorCodes.MEMBERSHIP_001);
    });
  });

  describe('assign — vehicle / company status gates', () => {
    it('rejects when the vehicle is not approved', async () => {
      vehicleRepo.findOne.mockResolvedValue(
        buildVehicle({ status: VehicleStatus.PENDING_APPROVAL }),
      );
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));

      await expect(
        service.assign({ driverId: 'driver-1', vehicleId: 'vehicle-1' }, OWNER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the owning company is suspended', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      companyRepo.findOne.mockResolvedValue(
        buildCompany({ status: CompanyStatus.SUSPENDED }),
      );

      await expect(
        service.assign({ driverId: 'driver-1', vehicleId: 'vehicle-1' }, OWNER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the vehicle does not exist', async () => {
      vehicleRepo.findOne.mockResolvedValue(null);
      await expect(
        service.assign({ driverId: 'driver-1', vehicleId: 'missing' }, OWNER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assign — duplicate handling', () => {
    it('translates Postgres 23505 into a ConflictException with ASSIGNMENT_001', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      memberships.isApprovedMember.mockResolvedValue(true);
      assignmentRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), {
          driverError: { code: '23505' },
        }),
      );

      let caught: unknown;
      try {
        await service.assign(
          { driverId: 'driver-1', vehicleId: 'vehicle-1' },
          OWNER,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as {
        errorCode: string;
      };
      expect(response.errorCode).toBe(ErrorCodes.ASSIGNMENT_001);
    });

    it('lets non-23505 errors propagate untouched', async () => {
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      driverProfileRepo.findOne.mockResolvedValue(buildDriverProfile({}));
      companyRepo.findOne.mockResolvedValue(buildCompany({}));
      memberships.isApprovedMember.mockResolvedValue(true);
      assignmentRepo.save.mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.assign({ driverId: 'driver-1', vehicleId: 'vehicle-1' }, OWNER),
      ).rejects.toThrow('boom');
    });
  });

  describe('unassign', () => {
    it('sets unassigned_at on the active assignment (admin)', async () => {
      const assignment = {
        id: 'assignment-1',
        driverId: 'driver-1',
        vehicleId: 'vehicle-1',
        assignedAt: new Date('2026-05-17T00:00:00Z'),
        unassignedAt: null,
      } as unknown as VehicleAssignment;
      assignmentRepo.findOne.mockResolvedValue(assignment);

      const result = await service.unassign('assignment-1', ADMIN);
      expect(result.unassignedAt).toBeInstanceOf(Date);
    });

    it('rejects already-inactive assignment with 400', async () => {
      assignmentRepo.findOne.mockResolvedValue({
        id: 'assignment-1',
        unassignedAt: new Date('2026-05-17T00:00:00Z'),
      } as unknown as VehicleAssignment);

      await expect(
        service.unassign('assignment-1', ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-owner caller (403)', async () => {
      assignmentRepo.findOne.mockResolvedValue({
        id: 'assignment-1',
        vehicleId: 'vehicle-1',
        unassignedAt: null,
      } as unknown as VehicleAssignment);
      vehicleRepo.findOne.mockResolvedValue(buildVehicle({}));
      companyRepo.findOne.mockResolvedValue(buildCompany({}));

      await expect(
        service.unassign('assignment-1', STRANGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
