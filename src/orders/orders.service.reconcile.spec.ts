import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
  PackageSize,
} from './entities/order.entity';
import {
  PaymentMethod,
  Transaction,
} from '../wallet/entities/transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { naira } from '../common/money';

function buildAdmin() {
  return { id: 'admin-1' } as never;
}

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-ref-1',
    customerId: 'customer-1',
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.BANK_TRANSFER,
    paymentStatus: OrderPaymentStatus.PENDING_TRANSFER,
    estimatedPrice: naira('2500'),
    finalPrice: null,
    packageSize: PackageSize.SMALL,
    ...overrides,
  } as Order;
}

function buildWallet(): Wallet {
  return {
    id: 'wallet-customer',
    userId: 'customer-1',
    balance: naira('0'),
  } as Wallet;
}

describe('OrdersService.reconcileBankTransfer (G3)', () => {
  let service: OrdersService;
  let configService: { getString: jest.Mock; getNumber: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: { findOne: jest.Mock; save: jest.Mock; insert: jest.Mock };

  beforeEach(() => {
    configService = {
      getString: jest.fn(),
      getNumber: jest.fn(),
    };
    manager = {
      findOne: jest.fn(),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      insert: jest.fn(() =>
        Promise.resolve({ identifiers: [], generatedMaps: [] }),
      ),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: EntityManager) => unknown) =>
        Promise.resolve(cb(manager as unknown as EntityManager)),
      ),
    };

    service = new OrdersService(
      {} as unknown as Repository<Order>,
      {} as never,
      configService as never,
      {} as never,
      {} as never,
      {} as never,
      dataSource as unknown as DataSource,
    );
  });

  it('inserts a Transaction + ApprovalDecision + flips paymentStatus to COMPLETED', async () => {
    const order = buildOrder();
    manager.findOne
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(buildWallet());

    const result = await service.reconcileBankTransfer(
      'order-ref-1',
      buildAdmin(),
    );

    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(result.finalPrice?.toString()).toBe('2500');

    expect(manager.insert).toHaveBeenCalledWith(
      Transaction,
      expect.objectContaining({
        paymentMethod: PaymentMethod.BANK_TRANSFER,
        reference: 'order-ref-1',
        orderId: 'order-ref-1',
      }),
    );
    expect(manager.insert).toHaveBeenCalledWith(
      ApprovalDecision,
      expect.objectContaining({
        targetType: ApprovalTargetType.ORDER,
        targetId: 'order-ref-1',
        action: ApprovalAction.APPROVE,
        reviewerId: 'admin-1',
      }),
    );
  });

  it('is idempotent — replay on a COMPLETED row returns the order untouched', async () => {
    manager.findOne.mockResolvedValueOnce(
      buildOrder({
        paymentStatus: OrderPaymentStatus.COMPLETED,
        finalPrice: naira('2500'),
      }),
    );

    const result = await service.reconcileBankTransfer(
      'order-ref-1',
      buildAdmin(),
    );

    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('404s for an unknown reference', async () => {
    manager.findOne.mockResolvedValueOnce(null);

    await expect(
      service.reconcileBankTransfer('typo-ref', buildAdmin()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects non bank-transfer orders', async () => {
    manager.findOne.mockResolvedValueOnce(
      buildOrder({ paymentMethod: PaymentMethod.CASH }),
    );

    await expect(
      service.reconcileBankTransfer('order-ref-1', buildAdmin()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the order is in an unexpected payment state', async () => {
    manager.findOne.mockResolvedValueOnce(
      buildOrder({ paymentStatus: OrderPaymentStatus.FAILED }),
    );

    await expect(
      service.reconcileBankTransfer('order-ref-1', buildAdmin()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the customer wallet is missing', async () => {
    manager.findOne
      .mockResolvedValueOnce(buildOrder())
      .mockResolvedValueOnce(null);

    await expect(
      service.reconcileBankTransfer('order-ref-1', buildAdmin()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OrdersService.getPlatformBankAccount (G3)', () => {
  function build(value: unknown): OrdersService {
    const configService = {
      getString: jest
        .fn()
        .mockResolvedValue(
          typeof value === 'string' ? value : JSON.stringify(value),
        ),
      getNumber: jest.fn(),
    };
    return new OrdersService(
      {} as unknown as Repository<Order>,
      {} as never,
      configService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('returns the parsed system_config JSON when present', async () => {
    const service = build({
      bankName: 'Zenith Bank',
      accountName: 'Orbit Technologies Ltd',
      accountNumber: '1234567890',
    });
    const out = await service.getPlatformBankAccount();
    expect(out).toEqual({
      bankName: 'Zenith Bank',
      accountName: 'Orbit Technologies Ltd',
      accountNumber: '1234567890',
    });
  });

  it('falls back to the placeholder shape when the JSON is malformed', async () => {
    const service = build('not-json');
    const out = await service.getPlatformBankAccount();
    expect(out.accountNumber).toBe('0000000000');
  });

  it('falls back to the placeholder shape when the value is empty', async () => {
    const service = build('');
    const out = await service.getPlatformBankAccount();
    expect(out.accountNumber).toBe('0000000000');
  });
});

describe('OrdersService.listPendingTransfers (G3)', () => {
  it('queries with the pending_transfer filter, oldest first', async () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const repo = { findAndCount } as unknown as Repository<Order>;
    const service = new OrdersService(
      repo,
      {} as never,
      { getNumber: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.listPendingTransfers({});

    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentStatus: OrderPaymentStatus.PENDING_TRANSFER },
        order: { createdAt: 'ASC' },
      }),
    );
  });
});

// Silence unused-import lint while ConfigKey isn't directly referenced
// in the tests above; the helper buildOrder etc. exercise the surface.
void ConfigKey;
