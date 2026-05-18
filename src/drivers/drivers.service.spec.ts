/* eslint-disable @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-assignment --
 * jest mock introspection is noisy under strict type-checked lint. */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DriversService } from './drivers.service';
import {
  DriverProfile,
  DriverVerificationStatus,
} from './entities/driver-profile.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Vehicle, VehicleStatus } from '../vehicles/entities/vehicle.entity';
import { UsersService } from '../users/users.service';
import { UserRole } from '../common/enums/user-role.enum';
import { ErrorCodes } from '../common/constants/error-codes';

type RepoMock = {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function buildRepoMock(): RepoMock {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((dto: Record<string, unknown>) => ({ ...dto })),
    save: jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ id: 'profile-1', ...row }),
    ),
    createQueryBuilder: jest.fn(),
  };
}

describe('DriversService', () => {
  let service: DriversService;
  let driverRepo: RepoMock;
  let assignmentRepo: RepoMock;
  let vehicleRepo: RepoMock;
  let usersService: { findById: jest.Mock };

  beforeEach(async () => {
    driverRepo = buildRepoMock();
    assignmentRepo = buildRepoMock();
    vehicleRepo = buildRepoMock();
    usersService = { findById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriversService,
        { provide: getRepositoryToken(DriverProfile), useValue: driverRepo },
        {
          provide: getRepositoryToken(VehicleAssignment),
          useValue: assignmentRepo,
        },
        { provide: getRepositoryToken(Vehicle), useValue: vehicleRepo },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get<DriversService>(DriversService);
  });

  describe('createProfile', () => {
    it('returns the existing profile when one is already present (idempotent)', async () => {
      const existing = { id: 'profile-existing', userId: 'user-1' };
      driverRepo.findOne.mockResolvedValue(existing);

      const result = await service.createProfile('user-1');

      expect(result).toEqual(existing);
      expect(driverRepo.create).not.toHaveBeenCalled();
      expect(driverRepo.save).not.toHaveBeenCalled();
    });

    it('creates a new profile when none exists', async () => {
      driverRepo.findOne.mockResolvedValue(null);

      const result = await service.createProfile('user-1');

      expect(driverRepo.create).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(driverRepo.save).toHaveBeenCalled();
      expect(result.userId).toBe('user-1');
    });

    it('uses the supplied EntityManager when provided', async () => {
      const managerRepo: RepoMock = buildRepoMock();
      managerRepo.findOne.mockResolvedValue(null);
      managerRepo.save.mockImplementation((row: Record<string, unknown>) =>
        Promise.resolve({ id: 'tx-1', ...row }),
      );
      const manager = {
        getRepository: jest.fn().mockReturnValue(managerRepo),
      } as unknown as Parameters<DriversService['createProfile']>[1];

      const result = await service.createProfile('user-1', manager);

      expect(managerRepo.findOne).toHaveBeenCalled();
      expect(managerRepo.create).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(managerRepo.save).toHaveBeenCalled();
      expect(driverRepo.findOne).not.toHaveBeenCalled();
      expect(driverRepo.save).not.toHaveBeenCalled();
      expect(result.userId).toBe('user-1');
    });
  });

  describe('updateOnlineStatus — going offline (no eligibility check)', () => {
    it('always allows isOnline=false even without an assignment', async () => {
      const profile = { id: 'p1', userId: 'u1', isOnline: true };
      driverRepo.findOne.mockResolvedValue(profile);
      driverRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.updateOnlineStatus('u1', false);

      expect(result.isOnline).toBe(false);
      // No assignment / vehicle query when going offline.
      expect(assignmentRepo.findOne).not.toHaveBeenCalled();
      expect(vehicleRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('updateOnlineStatus — going online (B5 gating)', () => {
    const profile = { id: 'p1', userId: 'u1', isOnline: false };

    it('allows isOnline=true when driver has an active assignment to an APPROVED vehicle', async () => {
      driverRepo.findOne.mockResolvedValue(profile);
      assignmentRepo.findOne.mockResolvedValue({
        id: 'a1',
        driverId: 'p1',
        vehicleId: 'v1',
        unassignedAt: null,
      });
      vehicleRepo.findOne.mockResolvedValue({
        id: 'v1',
        status: VehicleStatus.APPROVED,
      });
      driverRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.updateOnlineStatus('u1', true);

      expect(result.isOnline).toBe(true);
    });

    it('rejects with DRIVER_003 when driver has no active assignment', async () => {
      driverRepo.findOne.mockResolvedValue(profile);
      assignmentRepo.findOne.mockResolvedValue(null);

      let caught: unknown;
      try {
        await service.updateOnlineStatus('u1', true);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errorCode: string;
        message: string;
      };
      expect(response.errorCode).toBe(ErrorCodes.DRIVER_003);
      expect(response.message).toBe(
        'Your assigned vehicle is not currently approved.',
      );
    });

    it('rejects with DRIVER_003 when the assigned vehicle is SUSPENDED', async () => {
      driverRepo.findOne.mockResolvedValue(profile);
      assignmentRepo.findOne.mockResolvedValue({
        id: 'a1',
        driverId: 'p1',
        vehicleId: 'v1',
        unassignedAt: null,
      });
      vehicleRepo.findOne.mockResolvedValue({
        id: 'v1',
        status: VehicleStatus.SUSPENDED,
      });

      await expect(
        service.updateOnlineStatus('u1', true),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with DRIVER_003 when the assigned vehicle row was deleted', async () => {
      driverRepo.findOne.mockResolvedValue(profile);
      assignmentRepo.findOne.mockResolvedValue({
        id: 'a1',
        driverId: 'p1',
        vehicleId: 'v1',
        unassignedAt: null,
      });
      vehicleRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateOnlineStatus('u1', true),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateOnlineStatus — backfill path (A3 carry)', () => {
    it('backfills the profile for a driver-role user missing one, then runs the eligibility check', async () => {
      // First findOne (findByUserId): no profile yet.
      driverRepo.findOne
        .mockResolvedValueOnce(null)
        // Second findOne (inside createProfile): also no row.
        .mockResolvedValueOnce(null);
      driverRepo.save.mockImplementation((p) =>
        Promise.resolve({ id: 'backfilled', ...p }),
      );
      usersService.findById.mockResolvedValue({
        id: 'u1',
        role: UserRole.DRIVER,
      });
      assignmentRepo.findOne.mockResolvedValue({
        id: 'a1',
        driverId: 'backfilled',
        vehicleId: 'v1',
        unassignedAt: null,
      });
      vehicleRepo.findOne.mockResolvedValue({
        id: 'v1',
        status: VehicleStatus.APPROVED,
      });

      const result = await service.updateOnlineStatus('u1', true);

      expect(usersService.findById).toHaveBeenCalledWith('u1');
      expect(driverRepo.create).toHaveBeenCalledWith({ userId: 'u1' });
      expect(result.isOnline).toBe(true);
    });

    it('throws NotFoundException when the user is not a driver', async () => {
      driverRepo.findOne.mockResolvedValue(null);
      usersService.findById.mockResolvedValue({
        id: 'u1',
        role: UserRole.CUSTOMER,
      });

      await expect(service.updateOnlineStatus('u1', true)).rejects.toThrow(
        NotFoundException,
      );
      expect(driverRepo.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the user does not exist at all', async () => {
      driverRepo.findOne.mockResolvedValue(null);
      usersService.findById.mockResolvedValue(null);

      await expect(service.updateOnlineStatus('u1', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findEligibleDrivers (B5 matching query)', () => {
    function buildQbMock(result: unknown[]): unknown {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(result),
      };
      return qb;
    }

    it('returns the rows produced by the four-filter join (3-drivers-online B5 scenario)', async () => {
      const rows = [
        {
          driverId: 'p1',
          userId: 'u1',
          currentLatitude: 6.5,
          currentLongitude: 3.4,
          vehicleId: 'v1',
          vehicleType: 'motorcycle',
          vehiclePlate: 'LSR-456-XY',
          assignmentId: 'a1',
        },
        {
          driverId: 'p2',
          userId: 'u2',
          currentLatitude: 6.45,
          currentLongitude: 3.42,
          vehicleId: 'v2',
          vehicleType: 'van',
          vehiclePlate: 'LAG-100-ZZ',
          assignmentId: 'a2',
        },
        {
          driverId: 'p3',
          userId: 'u3',
          currentLatitude: 6.55,
          currentLongitude: 3.41,
          vehicleId: 'v3',
          vehicleType: 'car',
          vehiclePlate: 'IKJ-200-CC',
          assignmentId: 'a3',
        },
      ];
      driverRepo.createQueryBuilder.mockReturnValue(buildQbMock(rows));

      const result = await service.findEligibleDrivers();

      expect(result).toHaveLength(3);
      expect(result[0].driverId).toBe('p1');
    });

    it('applies the verificationStatus=active filter to the query builder', async () => {
      const qb = buildQbMock([]);
      driverRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findEligibleDrivers();

      const whereArgs = (qb as { where: jest.Mock }).where.mock.calls[0];
      expect(whereArgs[0]).toContain('"verificationStatus"');
      expect(whereArgs[1]).toEqual({
        active: DriverVerificationStatus.ACTIVE,
      });
    });

    it('applies the isOnline=true filter', async () => {
      const qb = buildQbMock([]);
      driverRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findEligibleDrivers();

      const andWhereCalls = (qb as { andWhere: jest.Mock }).andWhere.mock
        .calls as unknown[][];
      expect(
        andWhereCalls.some((args) =>
          (args[0] as string).includes('"isOnline" = true'),
        ),
      ).toBe(true);
    });
  });
});
