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
  let transactionsRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let ordersRepo: { findOne: jest.Mock };
  let walletRepo: { findOne: jest.Mock };
  let txManager: { findOne: jest.Mock; save: jest.Mock };
  let dataSource: {
    transaction: jest.Mock;
    getRepository: jest.Mock;
  };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    gateway = {
      createVirtualAccount: jest.fn(),
      initializePayment: jest.fn().mockResolvedValue({
        accessCode: 'AC-1',
        reference: 'txn-1',
        authorizationUrl: 'https://paystack.test/checkout/AC-1',
      }),
      verifyWebhookSignature: jest.fn(),
      parseWebhookEvent: jest.fn(),
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
        { provide: 'PAYMENT_GATEWAY', useValue: gateway },
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
    it('credits the wallet + flips the transaction to COMPLETED + emits payment.succeeded', async () => {
      const txn = buildTransaction({ status: TransactionStatus.PENDING });
      const wallet = buildWallet({ balance: naira('100') });
      txManager.findOne
        .mockResolvedValueOnce(txn)
        .mockResolvedValueOnce(wallet);

      await service.settleSuccessfulCharge('txn-1');

      expect(wallet.balance.toString()).toBe('4600');
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

  describe('verifyWebhookSignature passthrough', () => {
    it('delegates to the underlying gateway', () => {
      gateway.verifyWebhookSignature.mockReturnValueOnce(true);
      const ok = service.verifyWebhookSignature(Buffer.from('x'), 'sig');
      expect(ok).toBe(true);
      expect(gateway.verifyWebhookSignature).toHaveBeenCalled();
    });
  });
});
