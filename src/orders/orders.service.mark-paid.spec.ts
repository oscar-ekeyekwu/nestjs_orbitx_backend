/* eslint-disable @typescript-eslint/no-unsafe-member-access --
 * jest mock introspection rules. */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
  PackageSize,
} from './entities/order.entity';
import { ConfigKey } from '../config/enums/config-keys.enum';
import {
  PaymentMethod,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../wallet/entities/transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { NAIRA_ZERO, naira } from '../common/money';

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'customer-1',
    driverId: 'driver-1',
    status: OrderStatus.DELIVERED,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: OrderPaymentStatus.PENDING_CASH,
    estimatedPrice: naira('1000'),
    finalPrice: null,
    packageSize: PackageSize.SMALL,
    ...overrides,
  } as Order;
}

function buildWallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet-driver',
    userId: 'driver-1',
    balance: NAIRA_ZERO,
    totalEarnings: NAIRA_ZERO,
    ...overrides,
  } as Wallet;
}

describe('OrdersService.markCashCollected (G2)', () => {
  let service: OrdersService;
  let configService: { getNumber: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };

  beforeEach(() => {
    configService = { getNumber: jest.fn().mockResolvedValue(20) };
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

    // G5 — walletService stub. applyCommission(grossFee, override?) is
    // the only call markCashCollected makes. The stub reads the same
    // configService.getNumber the legacy tests already mock so the
    // existing commission expectations stay valid.
    type NairaLike = import('../common/money').Naira;
    const walletService = {
      applyCommission: jest.fn(
        async (
          grossFee: NairaLike,
          override?: number,
        ): Promise<{
          driverShare: NairaLike;
          commission: NairaLike;
          commissionPct: number;
        }> => {
          const pct: number =
            override ??
            ((await configService.getNumber(
              'DRIVER_COMMISSION_PERCENTAGE',
              0,
            )) as number);
          const commission = grossFee.times(pct).dividedBy(100) as NairaLike;
          const driverShare = grossFee.minus(commission) as NairaLike;
          return { driverShare, commission, commissionPct: pct };
        },
      ),
    };

    service = new OrdersService(
      {} as unknown as Repository<Order>,
      walletService as never,
      configService as never,
      {} as never,
      {} as never,
      { emit: jest.fn() } as never,
      {} as never,
      dataSource as unknown as DataSource,
    );
  });

  it('credits the driver wallet net of commission + inserts a cash transaction', async () => {
    const order = buildOrder();
    const wallet = buildWallet();
    manager.findOne.mockResolvedValueOnce(order).mockResolvedValueOnce(wallet);

    const result = await service.markCashCollected('order-1', 'driver-1');

    // 20% commission on ₦1000 = ₦200 → driver share = ₦800.
    expect(wallet.balance.toString()).toBe('800');
    expect(wallet.totalEarnings.toString()).toBe('800');
    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(result.finalPrice?.toString()).toBe('1000');

    // Exactly one Transaction row with method=cash + commission recorded.
    expect(manager.insert).toHaveBeenCalledWith(
      Transaction,
      expect.objectContaining({
        type: TransactionType.CREDIT,
        paymentMethod: PaymentMethod.CASH,
        status: TransactionStatus.COMPLETED,
        orderId: 'order-1',
      }),
    );
    const inserted = manager.insert.mock.calls[0][1] as {
      amount: { toString(): string };
      commission: { toString(): string };
      balanceAfter: { toString(): string };
    };
    expect(inserted.amount.toString()).toBe('800');
    expect(inserted.commission.toString()).toBe('200');
    expect(inserted.balanceAfter.toString()).toBe('800');
  });

  it('falls back to estimatedPrice when finalPrice is unset, then writes finalPrice', async () => {
    const order = buildOrder({
      estimatedPrice: naira('1500'),
      finalPrice: null,
    });
    manager.findOne
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(buildWallet());

    const result = await service.markCashCollected('order-1', 'driver-1');
    expect(result.finalPrice?.toString()).toBe('1500');
  });

  it('uses finalPrice when present (overrides estimate)', async () => {
    const order = buildOrder({
      estimatedPrice: naira('1500'),
      finalPrice: naira('1800'),
    });
    const wallet = buildWallet();
    manager.findOne.mockResolvedValueOnce(order).mockResolvedValueOnce(wallet);

    await service.markCashCollected('order-1', 'driver-1');
    // 20% of ₦1800 = ₦360 → driver gets ₦1440.
    expect(wallet.balance.toString()).toBe('1440');
  });

  it('is idempotent — second call on a COMPLETED row returns the order untouched', async () => {
    const order = buildOrder({
      paymentStatus: OrderPaymentStatus.COMPLETED,
      finalPrice: naira('1000'),
    });
    manager.findOne.mockResolvedValueOnce(order);

    const result = await service.markCashCollected('order-1', 'driver-1');

    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('rejects a non-driver caller', async () => {
    manager.findOne.mockResolvedValueOnce(buildOrder({ driverId: 'driver-2' }));

    await expect(
      service.markCashCollected('order-1', 'driver-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-cash orders', async () => {
    manager.findOne.mockResolvedValueOnce(
      buildOrder({ paymentMethod: PaymentMethod.CARD }),
    );

    await expect(
      service.markCashCollected('order-1', 'driver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects orders that are not yet delivered', async () => {
    manager.findOne.mockResolvedValueOnce(
      buildOrder({ status: OrderStatus.IN_TRANSIT }),
    );

    await expect(
      service.markCashCollected('order-1', 'driver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the order is missing', async () => {
    manager.findOne.mockResolvedValueOnce(null);

    await expect(
      service.markCashCollected('order-1', 'driver-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the driver has no wallet provisioned', async () => {
    manager.findOne
      .mockResolvedValueOnce(buildOrder())
      .mockResolvedValueOnce(null);

    await expect(
      service.markCashCollected('order-1', 'driver-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads commission percent from system_config', async () => {
    manager.findOne
      .mockResolvedValueOnce(buildOrder())
      .mockResolvedValueOnce(buildWallet());

    await service.markCashCollected('order-1', 'driver-1');

    expect(configService.getNumber).toHaveBeenCalledWith(
      ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
      0,
    );
  });

  it('handles a zero-commission config — driver gets the full fee', async () => {
    configService.getNumber.mockResolvedValueOnce(0);
    const wallet = buildWallet();
    manager.findOne
      .mockResolvedValueOnce(buildOrder({ finalPrice: naira('1000') }))
      .mockResolvedValueOnce(wallet);

    await service.markCashCollected('order-1', 'driver-1');
    expect(wallet.balance.toString()).toBe('1000');
  });
});
