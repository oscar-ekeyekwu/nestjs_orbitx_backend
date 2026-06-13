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
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { PaymentService } from './payment.service';
import { PaymentGatewayRegistry } from './payment-gateway.registry';
import { Order } from '../orders/entities/order.entity';
import {
  PaymentMethod,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../wallet/entities/transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { NAIRA_ZERO, naira } from '../common/money';
import type { IPaymentGateway } from './interfaces/payment-gateway.interface';

function buildTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1',
    walletId: 'wallet-1',
    orderId: 'order-1',
    type: TransactionType.CREDIT,
    amount: naira('4500'),
    commission: NAIRA_ZERO,
    balanceAfter: NAIRA_ZERO,
    status: TransactionStatus.PENDING,
    paymentMethod: PaymentMethod.CARD,
    description: '',
    reference: '',
    metadata: {},
    createdAt: new Date(),
    ...overrides,
  } as Transaction;
}

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'customer-1',
    estimatedPrice: naira('4500'),
    finalPrice: null,
    ...overrides,
  } as Order;
}

function buildWallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet-1',
    userId: 'customer-1',
    balance: naira('100'),
    ...overrides,
  } as Wallet;
}

describe('PaymentService (ARCH-13)', () => {
  let service: PaymentService;
  let gateway: jest.Mocked<IPaymentGateway>;
  let registry: {
    getActive: jest.Mock;
    get: jest.Mock;
    invalidate: jest.Mock;
    invalidateAll: jest.Mock;
    cacheSize: jest.Mock;
  };
  let transactionsRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let ordersRepo: { findOne: jest.Mock };
  let walletRepo: { findOne: jest.Mock };
  let txManager: {
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: {
    transaction: jest.Mock;
    getRepository: jest.Mock;
  };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    gateway = {
      providerId: 'provider-test',
      providerSlug: 'paystack-test',
      createVirtualAccount: jest.fn(),
      initializePayment: jest.fn().mockResolvedValue({
        accessCode: 'AC-1',
        reference: 'txn-1',
        authorizationUrl: 'https://paystack.test/checkout/AC-1',
      }),
      verifyPayment: jest.fn(),
      // G4 — added to IPaymentGateway after the spec file was written;
      // tests don't exercise the transfer path but the type needs the
      // method to be present.
      createTransfer: jest.fn(),
      verifyWebhookSignature: jest.fn(),
      parseWebhookEvent: jest.fn(),
      // PAY-1 — registry's admin test surface. Not exercised here.
      testConnection: jest.fn(),
    };
    registry = {
      getActive: jest.fn().mockResolvedValue(gateway),
      get: jest.fn().mockResolvedValue(gateway),
      invalidate: jest.fn(),
      invalidateAll: jest.fn(),
      cacheSize: jest.fn(() => 0),
    };
    transactionsRepo = {
      findOne: jest.fn(),
      save: jest.fn((t: Transaction) =>
        Promise.resolve({ ...t, id: t.id ?? 'txn-1' }),
      ),
      create: jest.fn((dto: Partial<Transaction>) => ({
        id: 'txn-1',
        ...dto,
      })),
    };
    ordersRepo = { findOne: jest.fn() };
    walletRepo = { findOne: jest.fn() };
    txManager = {
      findOne: jest.fn(),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      // PaymentService.settleSuccessfulCharge now computes
      // balanceAfter via a ledger SUM through the active manager.
      // Default to a 0-balance ledger; tests can override by spying
      // on this builder if they need a non-zero starting balance.
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
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(txManager as unknown as EntityManager),
      ),
      getRepository: jest.fn(() => walletRepo),
    };
    events = { emit: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PaymentGatewayRegistry, useValue: registry },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepo,
        },
        { provide: getRepositoryToken(Order), useValue: ordersRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = mod.get(PaymentService);
  });

  describe('initializeOrderPayment', () => {
    it('mints a PENDING transaction, calls Paystack, returns the hosted-page URL', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(buildOrder());
      walletRepo.findOne.mockResolvedValueOnce(buildWallet());

      const out = await service.initializeOrderPayment(
        'order-1',
        'customer-1',
        'chioma@example.com',
      );

      expect(out.authorizationUrl).toBe('https://paystack.test/checkout/AC-1');
      expect(transactionsRepo.save).toHaveBeenCalledTimes(1);
      const saved = transactionsRepo.save.mock.calls[0][0] as Transaction;
      expect(saved.status).toBe(TransactionStatus.PENDING);
      expect(saved.orderId).toBe('order-1');
      expect(gateway.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: out.transactionId,
          orderId: 'order-1',
          email: 'chioma@example.com',
          amountNaira: 4500,
        }),
      );
    });

    it('forbids a caller who is not the order customer', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(buildOrder());

      await expect(
        service.initializeOrderPayment('order-1', 'someone-else', 'x@y.com'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(gateway.initializePayment).not.toHaveBeenCalled();
    });

    it('404s when the order does not exist', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.initializeOrderPayment('missing', 'customer-1', 'x@y.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects zero-amount orders', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(
        buildOrder({ estimatedPrice: NAIRA_ZERO, finalPrice: null }),
      );
      walletRepo.findOne.mockResolvedValueOnce(buildWallet());

      await expect(
        service.initializeOrderPayment('order-1', 'customer-1', 'x@y.com'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(gateway.initializePayment).not.toHaveBeenCalled();
    });
  });

  describe('settleSuccessfulCharge', () => {
    it('flips the transaction to COMPLETED with balanceAfter computed against the live ledger + emits payment.succeeded', async () => {
      // Ledger-driven model: wallet.balance is derived from the
      // transactions table via the wallet_balances view, so the
      // service no longer mutates it. balanceAfter on the settling
      // row = current ledger (mocked '100' below) + txn amount.
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      const wallet = buildWallet({ balance: naira('100') });
      txManager.findOne
        .mockResolvedValueOnce(txn)
        .mockResolvedValueOnce(wallet);
      (
        txManager.createQueryBuilder as jest.Mock
      ).mockImplementationOnce(() => {
        const builder: Record<string, unknown> = {};
        Object.assign(builder, {
          select: jest.fn(() => builder),
          from: jest.fn(() => builder),
          where: jest.fn(() => builder),
          getRawOne: jest.fn().mockResolvedValue({ balance: '100' }),
        });
        return builder;
      });

      await service.settleSuccessfulCharge('txn-1');

      expect(txn.status).toBe(TransactionStatus.COMPLETED);
      expect(txn.balanceAfter.toString()).toBe('4600');
      expect(events.emit).toHaveBeenCalledWith('payment.succeeded', {
        reference: 'txn-1',
      });
    });

    it('is idempotent — a replayed webhook on a COMPLETED row is a no-op', async () => {
      const txn = buildTransaction({ status: TransactionStatus.COMPLETED });
      txManager.findOne.mockResolvedValueOnce(txn);

      await service.settleSuccessfulCharge('txn-1');

      // Wallet was never looked up; nothing got saved.
      expect(txManager.findOne).toHaveBeenCalledTimes(1);
      expect(txManager.save).not.toHaveBeenCalled();
      // The succeeded event still fires (downstream consumers may
      // need to re-deliver the customer notification on replay).
      expect(events.emit).toHaveBeenCalledWith('payment.succeeded', {
        reference: 'txn-1',
      });
    });

    it('logs but does not throw when the transaction is unknown (orphan webhook)', async () => {
      txManager.findOne.mockResolvedValueOnce(null);
      await service.settleSuccessfulCharge('ghost-ref');
      expect(txManager.save).not.toHaveBeenCalled();
    });
  });

  describe('markChargeFailed', () => {
    it('flips a pending row to FAILED + emits payment.failed', async () => {
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      transactionsRepo.findOne.mockResolvedValueOnce(txn);

      await service.markChargeFailed('txn-1');

      expect(txn.status).toBe(TransactionStatus.FAILED);
      expect(transactionsRepo.save).toHaveBeenCalledWith(txn);
      expect(events.emit).toHaveBeenCalledWith('payment.failed', {
        reference: 'txn-1',
      });
    });

    it('is idempotent on a row already marked FAILED', async () => {
      const txn = buildTransaction({ status: TransactionStatus.FAILED });
      transactionsRepo.findOne.mockResolvedValueOnce(txn);

      await service.markChargeFailed('txn-1');

      expect(transactionsRepo.save).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('refuses to clobber a COMPLETED transaction', async () => {
      const txn = buildTransaction({ status: TransactionStatus.COMPLETED });
      transactionsRepo.findOne.mockResolvedValueOnce(txn);

      await service.markChargeFailed('txn-1');

      expect(transactionsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('verifyOrderPayment (G1)', () => {
    it('short-circuits when the local row is already COMPLETED', async () => {
      const txn = buildTransaction({ status: TransactionStatus.COMPLETED });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'customer-1',
        role: 'customer',
      });

      expect(out.status).toBe('completed');
      expect(gateway.verifyPayment).not.toHaveBeenCalled();
    });

    it('short-circuits when the local row is already FAILED', async () => {
      const txn = buildTransaction({ status: TransactionStatus.FAILED });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'customer-1',
        role: 'customer',
      });

      expect(out.status).toBe('failed');
      expect(gateway.verifyPayment).not.toHaveBeenCalled();
    });

    it('reconciles a PENDING row via gateway and settles on success', async () => {
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });
      gateway.verifyPayment.mockResolvedValueOnce({
        reference: 'txn-1',
        status: 'success',
        amount: 4500,
      });
      // settleSuccessfulCharge runs in a transaction.
      txManager.findOne
        .mockResolvedValueOnce(txn)
        .mockResolvedValueOnce(buildWallet());

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'customer-1',
        role: 'customer',
      });

      expect(out.status).toBe('completed');
      expect(gateway.verifyPayment).toHaveBeenCalledWith('txn-1');
    });

    it('reconciles a PENDING row via gateway and fails on failure', async () => {
      const pendingTxn = buildTransaction({
        status: TransactionStatus.PENDING,
      });
      transactionsRepo.findOne
        .mockResolvedValueOnce({
          ...pendingTxn,
          order: { customerId: 'customer-1' },
        })
        // Second findOne is from markChargeFailed.
        .mockResolvedValueOnce(pendingTxn);
      gateway.verifyPayment.mockResolvedValueOnce({
        reference: 'txn-1',
        status: 'failed',
        amount: 4500,
      });

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'customer-1',
        role: 'customer',
      });

      expect(out.status).toBe('failed');
    });

    it('returns pending when Paystack itself still says pending', async () => {
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });
      gateway.verifyPayment.mockResolvedValueOnce({
        reference: 'txn-1',
        status: 'pending',
        amount: 0,
      });

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'customer-1',
        role: 'customer',
      });

      expect(out.status).toBe('pending');
    });

    it('gracefully stays pending if the gateway throws', async () => {
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });
      gateway.verifyPayment.mockRejectedValueOnce(new Error('paystack down'));

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'customer-1',
        role: 'customer',
      });

      expect(out.status).toBe('pending');
    });

    it('rejects a non-customer caller', async () => {
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });

      await expect(
        service.verifyOrderPayment('txn-1', {
          id: 'someone-else',
          role: 'customer',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admins can verify any reference', async () => {
      const txn = buildTransaction({ status: TransactionStatus.COMPLETED });
      transactionsRepo.findOne.mockResolvedValueOnce({
        ...txn,
        order: { customerId: 'customer-1' },
      });

      const out = await service.verifyOrderPayment('txn-1', {
        id: 'admin-1',
        role: 'admin',
      });

      expect(out.status).toBe('completed');
    });

    it('404s for an unknown reference', async () => {
      transactionsRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.verifyOrderPayment('ghost', {
          id: 'customer-1',
          role: 'customer',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('verifyWebhookSignature passthrough', () => {
    it('resolves the active gateway and delegates', async () => {
      gateway.verifyWebhookSignature.mockReturnValueOnce(true);
      const ok = await service.verifyWebhookSignature(Buffer.from('x'), 'sig');
      expect(ok).toBe(true);
      expect(gateway.verifyWebhookSignature).toHaveBeenCalled();
      expect(registry.getActive).toHaveBeenCalled();
    });
  });
});
