/* eslint-disable @typescript-eslint/no-unsafe-member-access --
 * jest mock-call introspection. */
import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus, PackageSize } from './entities/order.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { naira, type Naira } from '../common/money';

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'cust-1',
    driverId: 'driver-1',
    status: OrderStatus.ACCEPTED,
    packageSize: PackageSize.MEDIUM,
    platformCharge: naira('200'),
    customer: { id: 'cust-1', email: 'c@x.io', phone: '+234', name: 'C' },
    ...overrides,
  } as unknown as Order;
}

describe('OrdersService.cancelOrder — charge refund', () => {
  let ordersRepo: jest.Mocked<Repository<Order>>;
  let walletService: { refundOrderCharge: jest.Mock };
  let realtimeGateway: { emitOrderStatusUpdate: jest.Mock };
  let notifications: { notifyOrderCancelled: jest.Mock };
  let service: OrdersService;
  let order: Order;

  function build(o: Order): void {
    order = o;
    ordersRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn((e: Order) => Promise.resolve(e)),
    } as unknown as jest.Mocked<Repository<Order>>;
    walletService = {
      refundOrderCharge: jest.fn().mockResolvedValue(undefined),
    };
    realtimeGateway = { emitOrderStatusUpdate: jest.fn() };
    notifications = {
      notifyOrderCancelled: jest.fn().mockResolvedValue(undefined),
    };
    service = new OrdersService(
      ordersRepo,
      walletService as never,
      {} as never,
      realtimeGateway as never,
      notifications as never,
      { emit: jest.fn() } as never,
      {} as never,
      {} as unknown as DataSource,
    );
  }

  it('refunds the held charge when an accepted order is cancelled', async () => {
    build(buildOrder({ status: OrderStatus.ACCEPTED }));

    await service.cancelOrder('order-1', 'driver-1', UserRole.DRIVER);

    expect(walletService.refundOrderCharge).toHaveBeenCalledWith(
      'driver-1',
      'order-1',
      expect.anything(),
    );
    const amount = walletService.refundOrderCharge.mock.calls[0][2] as Naira;
    expect(amount.toString()).toBe('200');
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  it('does not refund a PENDING order (nothing was ever held)', async () => {
    build(buildOrder({ status: OrderStatus.PENDING }));

    await service.cancelOrder('order-1', 'cust-1', UserRole.CUSTOMER);

    expect(walletService.refundOrderCharge).not.toHaveBeenCalled();
  });

  it('refunds NAIRA_ZERO when platformCharge is null (no-op downstream)', async () => {
    build(buildOrder({ status: OrderStatus.PICKED_UP, platformCharge: null }));

    await service.cancelOrder('order-1', 'driver-1', UserRole.DRIVER);

    const amount = walletService.refundOrderCharge.mock.calls[0][2] as Naira;
    expect(amount.toString()).toBe('0');
  });

  it('rejects cancelling a delivered order', async () => {
    build(buildOrder({ status: OrderStatus.DELIVERED }));

    await expect(
      service.cancelOrder('order-1', 'driver-1', UserRole.DRIVER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(walletService.refundOrderCharge).not.toHaveBeenCalled();
  });
});
