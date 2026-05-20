import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { SystemConfigService } from '../config/config.service';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/entities/user.entity';
import {
  VehiclePendingUpdate,
  VehiclePendingUpdateStatus,
} from './entities/vehicle-pending-update.entity';
import { VehiclePendingUpdatesService } from './vehicle-pending-updates.service';
import { Vehicle, VehicleStatus, VehicleType } from './entities/vehicle.entity';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    role: UserRole.ADMIN,
    ...overrides,
  } as User;
}

function buildPending(
  overrides: Partial<VehiclePendingUpdate> = {},
): VehiclePendingUpdate {
  return {
    id: 'pending-1',
    vehicleId: 'vehicle-1',
    proposedType: null,
    proposedPlate: 'NEW-222-CD',
    submittedBy: 'driver-1',
    status: VehiclePendingUpdateStatus.PENDING,
    reviewedBy: null,
    reviewedAt: null,
    reviewReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as VehiclePendingUpdate;
}

describe('VehiclePendingUpdatesService (F2)', () => {
  let service: VehiclePendingUpdatesService;
  let pendingRepo: {
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findAndCount: jest.Mock;
  };
  let vehicleRepo: { findOne: jest.Mock };
  let txManager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let approvals: ApprovalsService;
  let config: { getString: jest.Mock };

  beforeEach(async () => {
    pendingRepo = {
      findOne: jest.fn(),
      count: jest.fn(),
      create: jest.fn((row: Partial<VehiclePendingUpdate>) => row),
      save: jest.fn((row: VehiclePendingUpdate) =>
        Promise.resolve({ ...row, id: row.id ?? 'pending-1' }),
      ),
      findAndCount: jest.fn(),
    };
    vehicleRepo = { findOne: jest.fn() };
    txManager = {
      findOne: jest.fn(),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      insert: jest.fn(() =>
        Promise.resolve({ identifiers: [], generatedMaps: [] }),
      ),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(txManager as unknown as EntityManager),
      ),
    };
    approvals = new ApprovalsService({
      find: jest.fn(),
      findAndCount: jest.fn(),
    } as unknown as Repository<
      import('../approvals/entities/approval-decision.entity').ApprovalDecision
    >);
    config = { getString: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        VehiclePendingUpdatesService,
        {
          provide: getRepositoryToken(VehiclePendingUpdate),
          useValue: pendingRepo,
        },
        { provide: getRepositoryToken(Vehicle), useValue: vehicleRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: ApprovalsService, useValue: approvals },
        { provide: SystemConfigService, useValue: config },
      ],
    }).compile();

    service = mod.get(VehiclePendingUpdatesService);
  });

  describe('submitForVehicle', () => {
    it('creates a pending row with proposed values uppercased', async () => {
      pendingRepo.findOne.mockResolvedValueOnce(null);
      const row = await service.submitForVehicle(
        'vehicle-1',
        { plate: 'new-222-cd', type: VehicleType.VAN },
        buildUser({ id: 'driver-1', role: UserRole.DRIVER }),
      );
      expect(row.status).toBe(VehiclePendingUpdateStatus.PENDING);
      expect(row.proposedPlate).toBe('NEW-222-CD');
      expect(row.proposedType).toBe(VehicleType.VAN);
      expect(row.submittedBy).toBe('driver-1');
    });

    it('throws ConflictException when a pending row already exists', async () => {
      pendingRepo.findOne.mockResolvedValueOnce(buildPending());
      await expect(
        service.submitForVehicle(
          'vehicle-1',
          { plate: 'NEW-444-EF' },
          buildUser(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an empty patch', async () => {
      pendingRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.submitForVehicle('vehicle-1', {}, buildUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('hasPendingFor / checkAcceptanceBlock', () => {
    it('hasPendingFor returns true when at least one pending row exists', async () => {
      pendingRepo.count.mockResolvedValueOnce(1);
      expect(await service.hasPendingFor('vehicle-1')).toBe(true);
    });

    it('hasPendingFor returns false when no pending rows exist', async () => {
      pendingRepo.count.mockResolvedValueOnce(0);
      expect(await service.hasPendingFor('vehicle-1')).toBe(false);
    });

    it('checkAcceptanceBlock returns null when grace mode is continue', async () => {
      config.getString.mockResolvedValueOnce('continue');
      expect(await service.checkAcceptanceBlock('vehicle-1')).toBeNull();
      // Should short-circuit without hitting the pending repo.
      expect(pendingRepo.count).not.toHaveBeenCalled();
    });

    it('checkAcceptanceBlock returns VEHICLE_002 when lock mode + pending row', async () => {
      config.getString.mockResolvedValueOnce('lock');
      pendingRepo.count.mockResolvedValueOnce(1);
      expect(await service.checkAcceptanceBlock('vehicle-1')).toBe(
        ErrorCodes.VEHICLE_002,
      );
    });

    it('checkAcceptanceBlock returns null when lock mode but no pending row', async () => {
      config.getString.mockResolvedValueOnce('lock');
      pendingRepo.count.mockResolvedValueOnce(0);
      expect(await service.checkAcceptanceBlock('vehicle-1')).toBeNull();
    });
  });

  describe('approve', () => {
    it('applies proposed values to the live vehicle + writes audit row', async () => {
      const pending = buildPending({
        proposedPlate: 'NEW-222-CD',
        proposedType: VehicleType.CAR,
      });
      const vehicle = {
        id: 'vehicle-1',
        plate: 'OLD-111-AB',
        type: VehicleType.MOTORCYCLE,
        status: VehicleStatus.APPROVED,
      };
      txManager.findOne
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(vehicle);

      const out = await service.approve(
        'pending-1',
        buildUser({ id: 'admin-1' }),
      );

      expect(vehicle.plate).toBe('NEW-222-CD');
      expect(vehicle.type).toBe(VehicleType.CAR);
      expect(out.status).toBe(VehiclePendingUpdateStatus.APPROVED);
      expect(out.reviewedBy).toBe('admin-1');
      expect(txManager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetType: ApprovalTargetType.VEHICLE,
          targetId: 'vehicle-1',
          action: ApprovalAction.APPROVE,
          reviewerId: 'admin-1',
        }),
      );
    });

    it('rejects a non-admin caller', async () => {
      await expect(
        service.approve(
          'pending-1',
          buildUser({ id: 'driver-1', role: UserRole.DRIVER }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the pending row is missing', async () => {
      txManager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.approve('missing', buildUser({ id: 'admin-1' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to re-approve a resolved row', async () => {
      txManager.findOne.mockResolvedValueOnce(
        buildPending({ status: VehiclePendingUpdateStatus.APPROVED }),
      );
      await expect(
        service.approve('pending-1', buildUser({ id: 'admin-1' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reject', () => {
    it('leaves the live vehicle untouched and writes an audit row', async () => {
      const pending = buildPending();
      txManager.findOne.mockResolvedValueOnce(pending);

      const out = await service.reject(
        'pending-1',
        buildUser({ id: 'admin-1' }),
        'plate mismatch',
      );

      expect(out.status).toBe(VehiclePendingUpdateStatus.REJECTED);
      expect(out.reviewReason).toBe('plate mismatch');
      // Vehicle row was never loaded by the reject path.
      expect(txManager.findOne).toHaveBeenCalledTimes(1);
      expect(txManager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: ApprovalAction.REJECT }),
      );
    });

    it('requires a non-empty reason', async () => {
      await expect(
        service.reject('pending-1', buildUser({ id: 'admin-1' }), '   '),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getGraceMode', () => {
    it('maps any unknown value to "continue" (safer default)', async () => {
      config.getString.mockResolvedValueOnce('garbage');
      expect(await service.getGraceMode()).toBe('continue');
    });

    it('returns "lock" only when literally set to "lock"', async () => {
      config.getString.mockResolvedValueOnce('lock');
      expect(await service.getGraceMode()).toBe('lock');
    });
  });

  describe('listPending', () => {
    it('orders oldest-first with default pagination', async () => {
      pendingRepo.findAndCount.mockResolvedValueOnce([[buildPending()], 1]);
      const out = await service.listPending({});
      expect(out.total).toBe(1);
      expect(pendingRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: VehiclePendingUpdateStatus.PENDING },
          order: { createdAt: 'ASC' },
        }),
      );
    });
  });
});
