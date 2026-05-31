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
import { PaymentMethod } from '../wallet/entities/transaction.entity';
import { naira } from '../common/money';

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

/**
 * Cash-only model: markCashCollected no longer touches the wallet. The
 * driver collected and keeps the cash; the platform already held its
 * per-order charge at acceptance. So this method only flips the payment
 * status to COMPLETED and stamps finalPrice — no commission split, no
 * wallet credit, no settlement Transaction row.
 */
describe('OrdersService.markCashCollected', () => {
  let service: OrdersService;
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };
  let walletService: { applyCommission: jest.Mock };

  beforeEach(() => {
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
    // Spy so we can assert it is NOT called on the cash path.
    walletService = { applyCommission: jest.fn() };

    service = new OrdersService(
      {} as unknown as Repository<Order>,
      walletService as never,
      {} as never,
      {} as never,
      {} as never,
      { emit: jest.fn() } as never,
      {} as never,
      dataSource as unknown as DataSource,
    );
  });

  it('marks payment COMPLETED without crediting the wallet or splitting commission', async () => {
    const order = buildOrder();
    manager.findOne.mockResolvedValueOnce(order);

    const result = await service.markCashCollected('order-1', 'driver-1');

    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(result.finalPrice?.toString()).toBe('1000');
    // No settlement transaction, no commission split, no wallet lookup.
    expect(manager.insert).not.toHaveBeenCalled();
    expect(walletService.applyCommission).not.toHaveBeenCalled();
    // Only the order row is saved (no wallet save).
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('falls back to estimatedPrice when finalPrice is unset', async () => {
    const order = buildOrder({
      estimatedPrice: naira('1500'),
      finalPrice: null,
    });
    manager.findOne.mockResolvedValueOnce(order);

    const result = await service.markCashCollected('order-1', 'driver-1');
    expect(result.finalPrice?.toString()).toBe('1500');
  });

  it('keeps finalPrice when already present', async () => {
    const order = buildOrder({
      estimatedPrice: naira('1500'),
      finalPrice: naira('1800'),
    });
    manager.findOne.mockResolvedValueOnce(order);

    const result = await service.markCashCollected('order-1', 'driver-1');
    expect(result.finalPrice?.toString()).toBe('1800');
  });

  it('is idempotent — second call on a COMPLETED row returns it untouched', async () => {
    const order = buildOrder({
      paymentStatus: OrderPaymentStatus.COMPLETED,
      finalPrice: naira('1000'),
    });
    manager.findOne.mockResolvedValueOnce(order);

    const result = await service.markCashCollected('order-1', 'driver-1');

    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
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
});
