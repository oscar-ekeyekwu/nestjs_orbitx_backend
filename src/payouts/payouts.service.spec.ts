/* eslint-disable @typescript-eslint/unbound-method,
                  @typescript-eslint/no-unsafe-member-access --
 * jest mock introspection rules. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { PayoutsService } from './payouts.service';
import { Payout, PayoutMethod, PayoutStatus } from './entities/payout.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import {
  PaymentMethod,
  Transaction,
} from '../wallet/entities/transaction.entity';
import { NAIRA_ZERO, naira } from '../common/money';
import type { IPaymentGateway } from '../payment/interfaces/payment-gateway.interface';
import { PaymentGatewayRegistry } from '../payment/payment-gateway.registry';

function buildAdmin(): User {
  return { id: 'admin-1', role: UserRole.ADMIN } as User;
}

function buildPayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: 'payout-1',
    recipientUserId: 'driver-1',
    walletId: 'wallet-1',
    amount: naira('5000'),
    status: PayoutStatus.PENDING_MANUAL,
    method: PayoutMethod.MANUAL,
    periodStart: new Date('2026-05-12T00:00:00.000Z'),
    periodEnd: new Date('2026-05-18T22:59:59.999Z'),
    paystackTransferCode: null,
    manualReceiptReference: null,
    completedBy: null,
    completedAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Payout;
}

function buildWallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet-1',
    userId: 'driver-1',
    balance: naira('5000'),
    totalWithdrawals: NAIRA_ZERO,
    ...overrides,
  } as Wallet;
}

describe('PayoutsService (G4)', () => {
  let service: PayoutsService;
  let payoutsRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    createQueryBuilder?: jest.Mock;
  };
  let walletsRepo: { createQueryBuilder: jest.Mock };
  let usersRepo: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let config: { getNumber: jest.Mock };
  let gateway: jest.Mocked<IPaymentGateway>;
  let registry: {
    getActive: jest.Mock;
    get: jest.Mock;
    invalidate: jest.Mock;
    invalidateAll: jest.Mock;
    cacheSize: jest.Mock;
  };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    payoutsRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn((p: Payout) =>
        Promise.resolve({ ...p, id: p.id ?? 'payout-1' }),
      ),
      create: jest.fn((dto: Partial<Payout>) => ({ id: 'payout-1', ...dto })),
      update: jest.fn().mockResolvedValue(undefined),
    };
    walletsRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getRawAndEntities: jest
          .fn()
          .mockResolvedValue({ entities: [], raw: [] }),
      }),
    };
    usersRepo = { findOne: jest.fn() };
    manager = {
      findOne: jest.fn(),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      insert: jest.fn(() =>
        Promise.resolve({ identifiers: [], generatedMaps: [] }),
      ),
      // settleAuto/manualComplete now compute balanceAfter through a
      // ledger SUM on the active manager.
      createQueryBuilder: jest.fn(() => {
        const builder: Record<string, unknown> = {};
        Object.assign(builder, {
          select: jest.fn(() => builder),
          from: jest.fn(() => builder),
          where: jest.fn(() => builder),
          getRawOne: jest.fn().mockResolvedValue({ balance: '0' }),
        });
        return builder;
      }),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: EntityManager) => unknown) =>
        Promise.resolve(cb(manager as unknown as EntityManager)),
      ),
    };
    config = { getNumber: jest.fn().mockResolvedValue(1000) };
    gateway = {
      providerId: 'provider-test',
      providerSlug: 'paystack-test',
      createVirtualAccount: jest.fn(),
      initializePayment: jest.fn(),
      verifyPayment: jest.fn(),
      createTransfer: jest.fn(),
      verifyWebhookSignature: jest.fn(),
      parseWebhookEvent: jest.fn(),
      testConnection: jest.fn(),
    };
    registry = {
      getActive: jest.fn().mockResolvedValue(gateway),
      get: jest.fn().mockResolvedValue(gateway),
      invalidate: jest.fn(),
      invalidateAll: jest.fn(),
      cacheSize: jest.fn(() => 0),
    };
    events = { emit: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        PayoutsService,
        { provide: getRepositoryToken(Payout), useValue: payoutsRepo },
        { provide: getRepositoryToken(Wallet), useValue: walletsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: SystemConfigService, useValue: config },
        { provide: PaymentGatewayRegistry, useValue: registry },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = mod.get(PayoutsService);
  });

  describe('generateWeeklyPayouts', () => {
    it('creates one pending payout per eligible recipient', async () => {
      const wallet = buildWallet();
      walletsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: [wallet],
          raw: [{ wb_balance: wallet.balance.toString() }],
        }),
      });

      const created = await service.generateWeeklyPayouts();

      expect(created).toHaveLength(1);
      expect(payoutsRepo.save).toHaveBeenCalledTimes(1);
      const saved = payoutsRepo.save.mock.calls[0][0] as Payout;
      expect(saved.status).toBe(PayoutStatus.PENDING);
      expect(saved.amount.toString()).toBe('5000');
      expect(config.getNumber).toHaveBeenCalledWith(
        ConfigKey.MIN_PAYOUT_THRESHOLD,
        1000,
      );
    });

    it('is idempotent — unique-violation on (recipient, periodStart) is swallowed', async () => {
      const wallet = buildWallet();
      walletsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: [wallet],
          raw: [{ wb_balance: wallet.balance.toString() }],
        }),
      });
      payoutsRepo.save.mockRejectedValueOnce(
        new Error('duplicate key value violates unique constraint'),
      );

      await expect(service.generateWeeklyPayouts()).resolves.toEqual([]);
    });
  });

  describe('dispatchPending', () => {
    it('routes recipients without a paystackRecipientCode into pending_manual', async () => {
      payoutsRepo.find.mockResolvedValueOnce([
        {
          ...buildPayout({ status: PayoutStatus.PENDING }),
          recipient: { paystackRecipientCode: null } as never,
        },
      ]);

      const result = await service.dispatchPending();

      expect(result.manual).toBe(1);
      expect(result.auto).toBe(0);
      expect(payoutsRepo.update).toHaveBeenCalledWith(
        'payout-1',
        expect.objectContaining({
          status: PayoutStatus.PENDING_MANUAL,
          method: PayoutMethod.MANUAL,
        }),
      );
      expect(gateway.createTransfer).not.toHaveBeenCalled();
    });

    it('settles via Paystack when a recipient code is on file', async () => {
      const payout = {
        ...buildPayout({ status: PayoutStatus.PENDING }),
        recipient: { paystackRecipientCode: 'RCP_x' } as never,
      };
      payoutsRepo.find.mockResolvedValueOnce([payout]);
      gateway.createTransfer.mockResolvedValueOnce({
        transferCode: 'TRF_1',
        reference: 'payout-1',
        status: 'success',
      });
      // settleAuto's transaction fetches the payout + wallet.
      manager.findOne
        .mockResolvedValueOnce(payout)
        .mockResolvedValueOnce(buildWallet());

      const result = await service.dispatchPending();

      expect(result.auto).toBe(1);
      expect(gateway.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientCode: 'RCP_x',
          reference: 'payout-1',
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'payout.succeeded',
        expect.objectContaining({ payoutId: 'payout-1', method: 'auto' }),
      );
    });

    it('marks failed + emits payout.failed when the gateway rejects', async () => {
      const payout = {
        ...buildPayout({ status: PayoutStatus.PENDING }),
        recipient: { paystackRecipientCode: 'RCP_x' } as never,
      };
      payoutsRepo.find.mockResolvedValueOnce([payout]);
      gateway.createTransfer.mockResolvedValueOnce({
        transferCode: '',
        reference: 'payout-1',
        status: 'failed',
      });

      const result = await service.dispatchPending();

      expect(result.failed).toBe(1);
      expect(payoutsRepo.update).toHaveBeenCalledWith(
        'payout-1',
        expect.objectContaining({ status: PayoutStatus.FAILED }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'payout.failed',
        expect.objectContaining({ payoutId: 'payout-1' }),
      );
    });
  });

  describe('markManualComplete', () => {
    it('settles via ledger SUM + inserts Transaction + flips status to PAID', async () => {
      // Ledger-driven model: settlement reads the live ledger
      // balance through the manager (no wallet.balance write). Mock
      // the ledger SUM to '5000' so the payout passes the overdraft
      // guard.
      const wallet = buildWallet({ balance: naira('5000') });
      manager.findOne
        .mockResolvedValueOnce(buildPayout())
        .mockResolvedValueOnce(wallet);
      (manager.createQueryBuilder as jest.Mock).mockImplementationOnce(
        () => {
          const builder: Record<string, unknown> = {};
          Object.assign(builder, {
            select: jest.fn(() => builder),
            from: jest.fn(() => builder),
            where: jest.fn(() => builder),
            getRawOne: jest.fn().mockResolvedValue({ balance: '5000' }),
          });
          return builder;
        },
      );

      const result = await service.markManualComplete(
        'payout-1',
        { receiptReference: 'NIBSS-12345' },
        buildAdmin(),
      );

      expect(result.status).toBe(PayoutStatus.PAID);
      expect(result.manualReceiptReference).toBe('NIBSS-12345');
      expect(result.completedBy).toBe('admin-1');
      expect(manager.insert).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          reference: 'NIBSS-12345',
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'payout.succeeded',
        expect.objectContaining({ method: 'manual' }),
      );
    });

    it('is idempotent — replay on a PAID row returns it untouched', async () => {
      manager.findOne.mockResolvedValueOnce(
        buildPayout({ status: PayoutStatus.PAID }),
      );

      const result = await service.markManualComplete(
        'payout-1',
        { receiptReference: 'NIBSS-12345' },
        buildAdmin(),
      );

      expect(result.status).toBe(PayoutStatus.PAID);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('refuses to overdraft a wallet', async () => {
      manager.findOne
        .mockResolvedValueOnce(buildPayout())
        .mockResolvedValueOnce(buildWallet({ balance: naira('100') }));

      await expect(
        service.markManualComplete(
          'payout-1',
          { receiptReference: 'NIBSS-12345' },
          buildAdmin(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires a receipt reference', async () => {
      await expect(
        service.markManualComplete(
          'payout-1',
          { receiptReference: '   ' },
          buildAdmin(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-admin caller', async () => {
      await expect(
        service.markManualComplete(
          'payout-1',
          { receiptReference: 'NIBSS-12345' },
          { id: 'driver-1', role: UserRole.DRIVER } as User,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s for an unknown payout', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.markManualComplete(
          'ghost',
          { receiptReference: 'NIBSS-12345' },
          buildAdmin(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a payout that is not pending_manual', async () => {
      manager.findOne.mockResolvedValueOnce(
        buildPayout({ status: PayoutStatus.PROCESSING }),
      );

      await expect(
        service.markManualComplete(
          'payout-1',
          { receiptReference: 'NIBSS-12345' },
          buildAdmin(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listManualPending', () => {
    it('queries pending_manual oldest first', async () => {
      payoutsRepo.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listManualPending({});
      expect(payoutsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: PayoutStatus.PENDING_MANUAL },
          order: { createdAt: 'ASC' },
        }),
      );
    });
  });

  describe('getStatementPlaceholder', () => {
    it('returns the deferred-feature placeholder per G4 AC', () => {
      const out = service.getStatementPlaceholder('p-1');
      expect(out).toEqual({
        payoutId: 'p-1',
        message: 'Statement download coming soon.',
      });
    });
  });
});
