/* eslint-disable @typescript-eslint/unbound-method,
                  @typescript-eslint/no-unsafe-member-access --
 * jest's mock introspection (.mock.calls[N][M], passing repo method
 * references to expect().toHaveBeenCalled()) trips these rules. Both
 * are noisy false-positives in spec code. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { VehiclesService, toVehicleResponse } from './vehicles.service';
import {
  Vehicle,
  VehicleOwnerType,
  VehicleStatus,
  VehicleType,
} from './entities/vehicle.entity';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  DriverAccountType,
  DriverProfile,
} from '../drivers/entities/driver-profile.entity';
import { ErrorCodes } from '../common/constants/error-codes';
import { UserRole } from '../common/enums/user-role.enum';
import type { User } from '../users/entities/user.entity';

const VEHICLE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function buildUser(overrides: Partial<User>): User {
  return {
    id: 'user-1',
    email: 'tunde@example.com',
    role: UserRole.DRIVER,
    ...overrides,
  } as unknown as User;
}

function buildProfile(overrides: Partial<DriverProfile>): DriverProfile {
  return {
    id: 'profile-1',
    userId: 'user-1',
    accountType: DriverAccountType.INDIVIDUAL,
    companyId: null,
    ...overrides,
  } as unknown as DriverProfile;
}

function buildVehicle(overrides: Partial<Vehicle>): Vehicle {
  return {
    id: VEHICLE_ID,
    type: VehicleType.MOTORCYCLE,
    plate: 'LSR-456-XY',
    color: 'Black',
    photoUrl: null,
    status: VehicleStatus.DRAFT,
    ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
    ownerId: 'profile-1',
    approvedAt: null,
    approvedBy: null,
    createdAt: new Date('2026-05-18T10:00:00Z'),
    updatedAt: new Date('2026-05-18T10:00:00Z'),
    ...overrides,
  } as unknown as Vehicle;
}

describe('VehiclesService (B3)', () => {
  let service: VehiclesService;
  let vehicleRepo: jest.Mocked<Repository<Vehicle>>;
  let driverProfileRepo: jest.Mocked<Repository<DriverProfile>>;
  let dataSource: { transaction: jest.Mock };
  let txManager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };

  beforeEach(() => {
    vehicleRepo = {
      create: jest.fn((dto: Partial<Vehicle>) => dto as Vehicle),
      save: jest.fn(),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    } as unknown as jest.Mocked<Repository<Vehicle>>;

    driverProfileRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<DriverProfile>>;

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

    const approvalsService = new ApprovalsService({
      find: jest.fn(),
      findAndCount: jest.fn(),
    } as unknown as Repository<ApprovalDecision>);

    service = new VehiclesService(
      vehicleRepo,
      driverProfileRepo,
      dataSource as unknown as DataSource,
      approvalsService,
    );
  });

  describe('create — ownership inference', () => {
    it('individual driver becomes owner_type=individual_driver + owner_id=profile.id', async () => {
      const profile = buildProfile({
        id: 'profile-1',
        accountType: DriverAccountType.INDIVIDUAL,
      });
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(profile);
      (vehicleRepo.save as jest.Mock).mockImplementation((v: Vehicle) =>
        Promise.resolve(v),
      );

      const result = await service.create(
        { type: VehicleType.MOTORCYCLE, plate: 'lsr-456-xy' },
        buildUser({}),
      );

      expect(result.ownerType).toBe(VehicleOwnerType.INDIVIDUAL_DRIVER);
      expect(result.ownerId).toBe('profile-1');
      expect(result.status).toBe(VehicleStatus.DRAFT);
      // Plates normalised to uppercase on the way in.
      expect(result.plate).toBe('LSR-456-XY');
    });

    it('company_owner with companyId set becomes owner_type=company + owner_id=companyId', async () => {
      const profile = buildProfile({
        accountType: DriverAccountType.COMPANY_OWNER,
        companyId: 'company-9',
      });
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(profile);
      (vehicleRepo.save as jest.Mock).mockImplementation((v: Vehicle) =>
        Promise.resolve(v),
      );

      const result = await service.create(
        { type: VehicleType.VAN, plate: 'LAG-100-ZZ' },
        buildUser({}),
      );

      expect(result.ownerType).toBe(VehicleOwnerType.COMPANY);
      expect(result.ownerId).toBe('company-9');
    });

    it('company_owner WITHOUT a companyId is rejected (400)', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({
          accountType: DriverAccountType.COMPANY_OWNER,
          companyId: null,
        }),
      );
      await expect(
        service.create(
          { type: VehicleType.MOTORCYCLE, plate: 'AAA-000-AA' },
          buildUser({}),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('company_employee is rejected (403)', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({
          accountType: DriverAccountType.COMPANY_EMPLOYEE,
          companyId: 'company-9',
        }),
      );
      await expect(
        service.create(
          { type: VehicleType.MOTORCYCLE, plate: 'AAA-000-AA' },
          buildUser({}),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('user with no driver profile is rejected (403)', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.create(
          { type: VehicleType.MOTORCYCLE, plate: 'AAA-000-AA' },
          buildUser({}),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('findByIdForUser', () => {
    it('admin sees any vehicle', async () => {
      const vehicle = buildVehicle({});
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(vehicle);

      const result = await service.findByIdForUser(
        VEHICLE_ID,
        buildUser({ role: UserRole.ADMIN }),
      );
      expect(result).toBe(vehicle);
      // Admin path doesn't query driver_profile.
      expect(driverProfileRepo.findOne).not.toHaveBeenCalled();
    });

    it('individual owner sees their own vehicle', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: 'profile-1',
      });
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(vehicle);
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({ id: 'profile-1' }),
      );

      const result = await service.findByIdForUser(VEHICLE_ID, buildUser({}));
      expect(result).toBe(vehicle);
    });

    it('company employee sees company-owned vehicle when companyId matches', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.COMPANY,
        ownerId: 'company-9',
      });
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(vehicle);
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({
          id: 'profile-2',
          accountType: DriverAccountType.COMPANY_EMPLOYEE,
          companyId: 'company-9',
        }),
      );

      const result = await service.findByIdForUser(VEHICLE_ID, buildUser({}));
      expect(result).toBe(vehicle);
    });

    it('foreign driver is rejected (403)', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: 'profile-1',
      });
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(vehicle);
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({ id: 'profile-2' }),
      );

      await expect(
        service.findByIdForUser(VEHICLE_ID, buildUser({})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404 propagates when no row matches', async () => {
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.findByIdForUser('missing', buildUser({})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateForUser (F1)', () => {
    function setupOwned(vehicle: Vehicle) {
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(vehicle);
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({ id: 'profile-1' }),
      );
      (vehicleRepo.save as jest.Mock).mockImplementation((v: Vehicle) =>
        Promise.resolve(v),
      );
    }

    it('cosmetic edit (color + photoUrl) applies and persists', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: 'profile-1',
        color: 'Black',
        photoUrl: null,
      });
      setupOwned(vehicle);

      const result = await service.updateForUser(
        VEHICLE_ID,
        { color: 'Red', photoUrl: 'https://cdn/x.jpg' },
        buildUser({}),
      );

      expect(result.color).toBe('Red');
      expect(result.photoUrl).toBe('https://cdn/x.jpg');
      expect(vehicleRepo.save).toHaveBeenCalledTimes(1);
    });

    it('regulatory edit (plate) uppercases on the way in', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: 'profile-1',
        plate: 'OLD-111-AB',
      });
      setupOwned(vehicle);

      const result = await service.updateForUser(
        VEHICLE_ID,
        { plate: 'new-222-cd' },
        buildUser({}),
      );

      expect(result.plate).toBe('NEW-222-CD');
    });

    it('partial patch leaves untouched fields alone', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: 'profile-1',
        color: 'Blue',
        plate: 'KEEP-777-EF',
        type: VehicleType.MOTORCYCLE,
      });
      setupOwned(vehicle);

      const result = await service.updateForUser(
        VEHICLE_ID,
        { color: 'Green' },
        buildUser({}),
      );

      expect(result.color).toBe('Green');
      expect(result.plate).toBe('KEEP-777-EF');
      expect(result.type).toBe(VehicleType.MOTORCYCLE);
    });

    it('clears color when explicitly set to null', async () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
        ownerId: 'profile-1',
        color: 'Blue',
      });
      setupOwned(vehicle);

      const result = await service.updateForUser(
        VEHICLE_ID,
        { color: null },
        buildUser({}),
      );

      expect(result.color).toBeNull();
    });

    it('rejects a caller who does not own the vehicle (403 via findByIdForUser)', async () => {
      (vehicleRepo.findOne as jest.Mock).mockResolvedValue(
        buildVehicle({
          ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
          ownerId: 'profile-1',
        }),
      );
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(
        buildProfile({ id: 'profile-2' }),
      );

      await expect(
        service.updateForUser(VEHICLE_ID, { color: 'Red' }, buildUser({})),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(vehicleRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('submitForApproval', () => {
    const owner = buildUser({});

    it('draft → pending_approval works for the owner', async () => {
      const vehicle = buildVehicle({ status: VehicleStatus.DRAFT });
      txManager.findOne
        .mockResolvedValueOnce(vehicle)
        .mockResolvedValueOnce(buildProfile({ id: 'profile-1' }));

      const result = await service.submitForApproval(VEHICLE_ID, owner);

      expect(result.status).toBe(VehicleStatus.PENDING_APPROVAL);
      expect(txManager.save).toHaveBeenCalled();
      // No approval_decisions row — submit is user-initiated, not an
      // admin action.
      expect(txManager.insert).not.toHaveBeenCalled();
    });

    it('rejects non-owner with 403 even on a valid draft', async () => {
      const vehicle = buildVehicle({
        status: VehicleStatus.DRAFT,
        ownerId: 'profile-1',
      });
      txManager.findOne
        .mockResolvedValueOnce(vehicle)
        .mockResolvedValueOnce(buildProfile({ id: 'profile-2' }));

      await expect(
        service.submitForApproval(VEHICLE_ID, owner),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects approved → pending_approval (illegal transition)', async () => {
      txManager.findOne
        .mockResolvedValueOnce(buildVehicle({ status: VehicleStatus.APPROVED }))
        .mockResolvedValueOnce(buildProfile({ id: 'profile-1' }));

      await expect(
        service.submitForApproval(VEHICLE_ID, owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('transitionStatus (admin)', () => {
    const admin = buildUser({ id: 'admin-1', role: UserRole.ADMIN });

    it('pending_approval → approved: sets approved_at + approved_by, writes APPROVE audit row', async () => {
      const vehicle = buildVehicle({
        status: VehicleStatus.PENDING_APPROVAL,
      });
      txManager.findOne.mockResolvedValue(vehicle);

      const result = await service.transitionStatus(
        VEHICLE_ID,
        { status: VehicleStatus.APPROVED, reason: 'Photos match' },
        admin,
      );

      expect(result.status).toBe(VehicleStatus.APPROVED);
      expect(result.approvedAt).toBeInstanceOf(Date);
      expect(result.approvedBy).toBe('admin-1');

      const insertCall = (txManager.insert.mock.calls[0] as unknown[]) ?? [];
      expect(insertCall[0]).toBe(ApprovalDecision);
      expect(insertCall[1]).toMatchObject({
        targetType: ApprovalTargetType.VEHICLE,
        targetId: VEHICLE_ID,
        action: ApprovalAction.APPROVE,
        reviewerId: 'admin-1',
        reason: 'Photos match',
      });
    });

    it('pending_approval → rejected: writes REJECT audit, does NOT touch approved_at', async () => {
      txManager.findOne.mockResolvedValue(
        buildVehicle({ status: VehicleStatus.PENDING_APPROVAL }),
      );

      const result = await service.transitionStatus(
        VEHICLE_ID,
        { status: VehicleStatus.REJECTED, reason: 'Plate unreadable' },
        admin,
      );

      expect(result.approvedAt).toBeNull();
      const insertCall = (txManager.insert.mock.calls[0] as unknown[]) ?? [];
      expect(insertCall[1]).toMatchObject({
        action: ApprovalAction.REJECT,
      });
    });

    it('active → suspended writes SUSPEND', async () => {
      txManager.findOne.mockResolvedValue(
        buildVehicle({ status: VehicleStatus.ACTIVE }),
      );

      await service.transitionStatus(
        VEHICLE_ID,
        { status: VehicleStatus.SUSPENDED, reason: 'Insurance lapsed' },
        admin,
      );

      const insertCall = (txManager.insert.mock.calls[0] as unknown[]) ?? [];
      expect(insertCall[1]).toMatchObject({ action: ApprovalAction.SUSPEND });
    });

    it('rejects draft → approved (must go through pending_approval first)', async () => {
      txManager.findOne.mockResolvedValue(
        buildVehicle({ status: VehicleStatus.DRAFT }),
      );

      let caught: unknown;
      try {
        await service.transitionStatus(
          VEHICLE_ID,
          { status: VehicleStatus.APPROVED },
          admin,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errorCode: string;
      };
      expect(response.errorCode).toBe(ErrorCodes.VEHICLE_001);
      expect(txManager.save).not.toHaveBeenCalled();
      expect(txManager.insert).not.toHaveBeenCalled();
    });
  });

  describe('findAllForUser (B6 caller-aware listing)', () => {
    const admin: User = {
      id: 'admin-1',
      email: 'admin@orbitx.com',
      role: UserRole.ADMIN,
    } as unknown as User;

    it('admin path delegates to the unscoped query (no profile lookup)', async () => {
      (vehicleRepo.findAndCount as jest.Mock).mockResolvedValue([
        [buildVehicle({})],
        1,
      ]);
      const result = await service.findAllForUser(admin, {
        status: VehicleStatus.APPROVED,
      });
      expect(result.total).toBe(1);
      expect(driverProfileRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns empty when the non-admin caller has no driver profile', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue(null);
      const result = await service.findAllForUser(buildUser({}));
      expect(result).toEqual({ items: [], total: 0 });
      expect(vehicleRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('individual driver sees both their own and (no) company vehicles', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        companyId: null,
      });
      (vehicleRepo.findAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await service.findAllForUser(buildUser({}));

      const arg = (vehicleRepo.findAndCount as jest.Mock).mock.calls[0][0] as {
        where: unknown[];
      };
      expect(arg.where).toEqual([
        {
          ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
          ownerId: 'profile-1',
        },
      ]);
    });

    it('company-linked driver sees individual + company-owned vehicles', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        companyId: 'company-9',
      });
      (vehicleRepo.findAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await service.findAllForUser(buildUser({}));

      const arg = (vehicleRepo.findAndCount as jest.Mock).mock.calls[0][0] as {
        where: unknown[];
      };
      expect(arg.where).toEqual([
        {
          ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
          ownerId: 'profile-1',
        },
        { ownerType: VehicleOwnerType.COMPANY, ownerId: 'company-9' },
      ]);
    });

    it('status filter is applied to each ownership bucket', async () => {
      (driverProfileRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        userId: 'user-1',
        companyId: 'company-9',
      });
      (vehicleRepo.findAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await service.findAllForUser(buildUser({}), {
        status: VehicleStatus.APPROVED,
      });

      const arg = (vehicleRepo.findAndCount as jest.Mock).mock.calls[0][0] as {
        where: unknown[];
      };
      expect(arg.where).toEqual([
        {
          ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER,
          ownerId: 'profile-1',
          status: VehicleStatus.APPROVED,
        },
        {
          ownerType: VehicleOwnerType.COMPANY,
          ownerId: 'company-9',
          status: VehicleStatus.APPROVED,
        },
      ]);
    });
  });

  describe('toVehicleResponse (wire shape)', () => {
    it('nests ownerType + ownerId under `owner` per B3 AC', () => {
      const vehicle = buildVehicle({
        ownerType: VehicleOwnerType.COMPANY,
        ownerId: 'company-9',
      });

      const wire = toVehicleResponse(vehicle);

      expect(wire.owner).toEqual({
        type: VehicleOwnerType.COMPANY,
        id: 'company-9',
      });
      // The flat columns are NOT in the wire shape.
      expect(
        (wire as unknown as Record<string, unknown>).ownerType,
      ).toBeUndefined();
      expect(
        (wire as unknown as Record<string, unknown>).ownerId,
      ).toBeUndefined();
    });
  });
});
