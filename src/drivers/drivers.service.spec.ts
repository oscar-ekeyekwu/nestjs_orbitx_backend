/* eslint-disable @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-assignment --
 * jest mock introspection is noisy under strict type-checked lint. */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DriversService } from './drivers.service';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  DriverProfile,
  DriverVerificationStatus,
} from './entities/driver-profile.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Vehicle, VehicleStatus } from '../vehicles/entities/vehicle.entity';
import { UsersService } from '../users/users.service';
import { UserRole } from '../common/enums/user-role.enum';
import { ErrorCodes } from '../common/constants/error-codes';
import { SystemConfigService } from '../config/config.service';

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
        // C5 added a DataSource dep for transitionVerification. Tests
        // that exercise non-transactional paths just need the token to
        // resolve; the transaction wrapper is covered separately in
        // companies/vehicles services that follow the same pattern.
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn((cb: (m: unknown) => unknown) =>
              Promise.resolve(cb({})),
            ),
          },
        },
        // C6: route audit-decision writes through the shared service.
        // For the tests that don't exercise transitionVerification this
        // is just a token; for the ones that do, the manager.insert spy
        // captures the call exactly as before the refactor.
        {
          provide: ApprovalsService,
          useValue: {
            recordDecision: jest.fn(
              (
                manager: { insert: jest.Mock },
                input: Record<string, unknown>,
              ): Promise<unknown> => {
                return manager.insert(
                  'approval_decisions',
                  input,
                ) as Promise<unknown>;
              },
            ),
          },
        },
        // ARCH-10: EventEmitter2 dep on DriversService.
        // The transitionVerification path emits driver.approved /
        // driver.rejected after the transaction commits.
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn().mockReturnValue(true) },
        },
        // I5: SystemConfigService dep for the Lagos service-zone check
        // at go-online time. Returns the default bbox so the unit tests
        // that don't supply coords exercise the existing online-toggle
        // paths without engaging the new geofence.
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue({
              latMin: 6.35,
              latMax: 6.7,
              lngMin: 3.1,
              lngMax: 3.55,
            }),
          },
        },
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

  describe('transitionVerification (C5)', () => {
    interface TxManager {
      findOne: jest.Mock;
      save: jest.Mock;
      insert: jest.Mock;
      update: jest.Mock;
    }
    let manager: TxManager;
    let dataSource: { transaction: jest.Mock };

    beforeEach(() => {
      manager = {
        findOne: jest.fn(),
        save: jest.fn((entity: unknown) => Promise.resolve(entity)),
        insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'ap-1' }] }),
        // D1 chained-approve auto-approves the driver's pending vehicle
        // via manager.update — fired with a partial criteria + payload.
        update: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      dataSource = {
        transaction: jest.fn((cb: (m: TxManager) => unknown) =>
          Promise.resolve(cb(manager)),
        ),
      };
      // Re-wire the service with our pinned transaction mock so we can
      // observe the manager calls. The DI container produced a sentinel
      // for DataSource in the top-level beforeEach which is fine for
      // type resolution; we swap it here only for these tests.

      (service as any).dataSource = dataSource;
    });

    const ADMIN = {
      id: 'admin-1',
      role: UserRole.ADMIN,
    } as unknown as Parameters<DriversService['transitionVerification']>[2];

    it('approves a pending driver and writes an approval_decisions row', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        verificationStatus: DriverVerificationStatus.PENDING_APPROVAL,
        isOnline: false,
      });

      const result = await service.transitionVerification(
        'd-1',
        {
          status: DriverVerificationStatus.APPROVED,
          reason: 'license + NIN verified',
        },
        ADMIN,
      );

      // D1 chained transition: pending_approval → approved auto-
      // promotes to active in the same transaction. The audit ledger
      // still records ONE row (action=APPROVE) per arch §1.2.
      expect(
        (result as { verificationStatus: DriverVerificationStatus })
          .verificationStatus,
      ).toBe(DriverVerificationStatus.ACTIVE);
      expect(manager.insert).toHaveBeenCalledTimes(1);
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetType: 'driver',
          action: 'approve',
          reviewerId: 'admin-1',
          reason: 'license + NIN verified',
        }),
      );
    });

    it('rejects pending_approval → rejected and forces driver offline', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        verificationStatus: DriverVerificationStatus.PENDING_APPROVAL,
        isOnline: true,
      });

      const result = await service.transitionVerification(
        'd-1',
        { status: DriverVerificationStatus.REJECTED, reason: 'bad selfie' },
        ADMIN,
      );

      expect((result as { isOnline: boolean }).isOnline).toBe(false);
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'reject', reason: 'bad selfie' }),
      );
    });

    it('refuses an illegal transition (rejected → approved) with DRIVER_002', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        verificationStatus: DriverVerificationStatus.REJECTED,
        isOnline: false,
      });

      await expect(
        service.transitionVerification(
          'd-1',
          { status: DriverVerificationStatus.APPROVED },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('admin lifts suspended_admin → pending_approval and the audit row records APPROVE-as-RESUME path is unsuitable; we record APPROVE for the resubmit edge', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        verificationStatus: DriverVerificationStatus.SUSPENDED_ADMIN,
        isOnline: false,
      });

      await service.transitionVerification(
        'd-1',
        {
          status: DriverVerificationStatus.PENDING_APPROVAL,
          reason: 'try again',
        },
        ADMIN,
      );

      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'approve' }),
      );
    });

    it('404 when the driver does not exist', async () => {
      manager.findOne.mockResolvedValue(null);

      await expect(
        service.transitionVerification(
          'missing',
          { status: DriverVerificationStatus.APPROVED },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('transitionVerification (D1 — chain + system path)', () => {
    interface TxManager {
      findOne: jest.Mock;
      save: jest.Mock;
      insert: jest.Mock;
      update: jest.Mock;
    }
    let manager: TxManager;
    let dataSource: { transaction: jest.Mock };

    beforeEach(() => {
      manager = {
        findOne: jest.fn(),
        save: jest.fn((entity: unknown) => Promise.resolve(entity)),
        insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'ap-1' }] }),
        // D1 chained-approve auto-approves the driver's pending vehicle
        // via manager.update — fired with a partial criteria + payload.
        update: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      dataSource = {
        transaction: jest.fn((cb: (m: TxManager) => unknown) =>
          Promise.resolve(cb(manager)),
        ),
      };

      (service as any).dataSource = dataSource;
    });

    it('pending_approval → approved chains to active (1 audit row, action=approve)', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        userId: 'u-1',
        verificationStatus: DriverVerificationStatus.PENDING_APPROVAL,
        isOnline: false,
      });

      const result = await service.transitionVerification(
        'd-1',
        { status: DriverVerificationStatus.APPROVED },
        { id: 'admin-1', role: UserRole.ADMIN } as never,
      );

      expect(
        (result as { verificationStatus: DriverVerificationStatus })
          .verificationStatus,
      ).toBe(DriverVerificationStatus.ACTIVE);
      // Exactly one audit row — the chained edge is operational state.
      expect(manager.insert).toHaveBeenCalledTimes(1);
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'approve' }),
      );
      // Two saves: the approved write + the active chain write.
      expect(manager.save).toHaveBeenCalledTimes(2);
    });

    it('system path: caller=null records reviewerId=NULL in the audit row', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        userId: 'u-1',
        verificationStatus: DriverVerificationStatus.ACTIVE,
        isOnline: true,
      });

      await service.transitionVerification(
        'd-1',
        { status: DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED },
        null,
      );

      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetType: 'driver',
          action: 'suspend',
          reviewerId: null,
        }),
      );
    });
  });

  describe('submitForApproval (D1)', () => {
    interface TxManager {
      findOne: jest.Mock;
      save: jest.Mock;
      insert: jest.Mock;
    }
    let manager: TxManager;

    beforeEach(() => {
      manager = {
        findOne: jest.fn(),
        save: jest.fn((entity: unknown) => Promise.resolve(entity)),
        insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'ap-1' }] }),
      };

      (service as any).dataSource = {
        transaction: jest.fn((cb: (m: TxManager) => unknown) =>
          Promise.resolve(cb(manager)),
        ),
      };
    });

    it('flips setup_required → pending_approval with reviewerId=NULL', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        userId: 'u-1',
        verificationStatus: DriverVerificationStatus.SETUP_REQUIRED,
        isOnline: false,
      });

      const result = await service.submitForApproval('d-1');

      expect(
        (result as { verificationStatus: DriverVerificationStatus })
          .verificationStatus,
      ).toBe(DriverVerificationStatus.PENDING_APPROVAL);
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'approve',
          reviewerId: null,
        }),
      );
    });

    it('refuses to re-submit from active (DRIVER_002)', async () => {
      manager.findOne.mockResolvedValue({
        id: 'd-1',
        userId: 'u-1',
        verificationStatus: DriverVerificationStatus.ACTIVE,
        isOnline: true,
      });

      await expect(service.submitForApproval('d-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('findPendingForAdmin (C5)', () => {
    it('returns rows + total via findAndCount filtered to pending_approval', async () => {
      driverRepo.findOne.mockResolvedValue(null);
      (
        driverRepo as unknown as {
          findAndCount: jest.Mock;
        }
      ).findAndCount = jest
        .fn()
        .mockResolvedValue([[{ id: 'd-1' }, { id: 'd-2' }], 2]);

      const result = await service.findPendingForAdmin({
        limit: 10,
        offset: 0,
      });

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      const callArgs = (
        driverRepo as unknown as {
          findAndCount: jest.Mock;
        }
      ).findAndCount.mock.calls[0][0];
      expect(callArgs).toMatchObject({
        where: {
          verificationStatus: DriverVerificationStatus.PENDING_APPROVAL,
        },
        take: 10,
        skip: 0,
      });
    });
  });
});
