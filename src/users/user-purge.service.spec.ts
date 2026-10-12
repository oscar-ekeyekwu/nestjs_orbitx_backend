/* eslint-disable @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-assignment --
 * jest mock introspection is noisy under strict type-checked lint. */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { UserPurgeService } from './user-purge.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { StorageRegistry } from '../storage/storage-registry.service';
import { User } from './entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { Company } from '../companies/entities/company.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { Order } from '../orders/entities/order.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Document } from '../documents/entities/document.entity';
import { ApprovalTargetType } from '../approvals/entities/approval-decision.entity';

type ManagerMock = {
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  delete: jest.Mock;
  update: jest.Mock;
};

function buildManager(): ManagerMock {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
}

function user(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 'u-1',
    email: 'tunde@example.com',
    first_name: 'Tunde',
    last_name: 'A',
    role: UserRole.DRIVER,
    ...overrides,
  });
}

const admin = user({ id: 'admin-1', role: UserRole.ADMIN });

describe('UserPurgeService', () => {
  let service: UserPurgeService;
  let manager: ManagerMock;
  let recordDecision: jest.Mock;
  let adapterDelete: jest.Mock;
  let transaction: jest.Mock;

  beforeEach(async () => {
    manager = buildManager();
    recordDecision = jest.fn().mockResolvedValue(undefined);
    adapterDelete = jest.fn().mockResolvedValue(undefined);
    transaction = jest.fn((cb: (m: ManagerMock) => Promise<unknown>) =>
      cb(manager),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserPurgeService,
        { provide: DataSource, useValue: { transaction } },
        { provide: ApprovalsService, useValue: { recordDecision } },
        {
          provide: StorageRegistry,
          useValue: {
            get: jest.fn().mockResolvedValue({ delete: adapterDelete }),
          },
        },
      ],
    }).compile();

    service = module.get(UserPurgeService);
  });

  it('refuses to delete the calling admin', async () => {
    await expect(service.purge('admin-1', admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('404s when the user does not exist', async () => {
    manager.findOne.mockResolvedValue(null);
    await expect(service.purge('missing', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete another admin account', async () => {
    manager.findOne.mockResolvedValue(user({ role: UserRole.ADMIN }));
    await expect(service.purge('u-1', admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('refuses when the user owns a company that still has other members', async () => {
    manager.findOne.mockResolvedValue(user());
    manager.find.mockImplementation((entity: unknown) =>
      Promise.resolve(
        entity === Company ? [{ id: 'c-1', legalName: 'Acme' }] : [],
      ),
    );
    manager.count.mockResolvedValue(2);
    await expect(service.purge('u-1', admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('deletes the user row last and records an audit decision', async () => {
    manager.findOne.mockResolvedValue(user());
    manager.find.mockImplementation((entity: unknown) => {
      if (entity === Wallet) return Promise.resolve([{ id: 'w-1' }]);
      if (entity === Order) return Promise.resolve([{ id: 'o-1' }]);
      if (entity === Vehicle) return Promise.resolve([{ id: 'v-1' }]);
      if (entity === Document)
        return Promise.resolve([
          { id: 'd-1', fileKey: 'user/u-1/a.jpg', storageProviderId: 'p-1' },
        ]);
      return Promise.resolve([]);
    });

    const result = await service.purge('u-1', admin);

    const deletedEntities = manager.delete.mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(deletedEntities[deletedEntities.length - 1]).toBe(User);
    // Orders go before wallets (transactions reference both), wallets
    // before the user, documents before vehicles.
    expect(deletedEntities.indexOf(Order)).toBeLessThan(
      deletedEntities.indexOf(Wallet),
    );
    expect(deletedEntities.indexOf(Document)).toBeLessThan(
      deletedEntities.indexOf(Vehicle),
    );

    expect(recordDecision).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        targetType: ApprovalTargetType.USER,
        targetId: 'u-1',
        reviewerId: 'admin-1',
      }),
    );
    expect(adapterDelete).toHaveBeenCalledWith('user/u-1/a.jpg');
    expect(result.removed.users).toBe(1);
  });

  it('translates a revoked-DELETE privilege error into a 409', async () => {
    manager.findOne.mockResolvedValue(user());
    const pgErr = new QueryFailedError('DELETE', [], new Error('denied'));
    (pgErr as QueryFailedError & { code?: string }).code = '42501';
    manager.delete.mockRejectedValue(pgErr);
    await expect(service.purge('u-1', admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('purgeMany reports per-id outcomes without aborting the batch', async () => {
    manager.findOne.mockImplementation((_e: unknown, opts: any) =>
      Promise.resolve(
        opts.where.id === 'gone' ? null : user({ id: opts.where.id }),
      ),
    );
    const result = await service.purgeMany(['u-1', 'gone', 'u-1'], admin);
    expect(result.deleted).toEqual(['u-1']);
    expect(result.failed).toEqual([{ id: 'gone', reason: 'User not found' }]);
  });
});
