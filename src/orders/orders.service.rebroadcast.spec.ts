import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus, PackageSize } from './entities/order.entity';
import { UserRole } from '../common/enums/user-role.enum';

type RebroadcastDeps = {
  ordersRepo: jest.Mocked<Repository<Order>>;
  realtimeGateway: {
    emitOrderOffered: jest.Mock;
    emitNewOrderToDrivers: jest.Mock;
  };
  eventEmitter: { emit: jest.Mock };
  notifications: { notifyOrderCreated: jest.Mock };
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'cust-1',
    status: OrderStatus.PENDING,
    packageSize: PackageSize.MEDIUM,
    pickupAddress: '1 Pickup St',
    deliveryAddress: '2 Delivery St',
    pickupLatitude: 6.5,
    pickupLongitude: 3.3,
    estimatedPrice: '1500.00',
    platformCharge: '100.00',
    ...overrides,
  } as unknown as Order;
}

function buildService(order: Order | null): {
  service: OrdersService;
  deps: RebroadcastDeps;
} {
  const ordersRepo = {
    findOne: jest.fn().mockResolvedValue(order),
  } as unknown as jest.Mocked<Repository<Order>>;

  const realtimeGateway = {
    emitOrderOffered: jest.fn(),
    emitNewOrderToDrivers: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const notifications = { notifyOrderCreated: jest.fn() };

  const service = new OrdersService(
    ordersRepo,
    {} as never,
    {} as never,
    realtimeGateway as never,
    notifications as never,
    eventEmitter as never,
    {} as never,
    {} as never,
    undefined,
  );

  return {
    service,
    deps: { ordersRepo, realtimeGateway, eventEmitter, notifications },
  };
}

describe('OrdersService.rebroadcast', () => {
  it('rejects unknown order with NotFoundException', async () => {
    const { service } = buildService(null);
    await expect(
      service.rebroadcast('missing', 'cust-1', UserRole.CUSTOMER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects callers that aren't the owner or admin", async () => {
    const { service } = buildService(makeOrder());
    await expect(
      service.rebroadcast('order-1', 'someone-else', UserRole.CUSTOMER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects orders that have already left PENDING', async () => {
    const { service } = buildService(
      makeOrder({ status: OrderStatus.ACCEPTED }),
    );
    await expect(
      service.rebroadcast('order-1', 'cust-1', UserRole.CUSTOMER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fans out socket + push when guards pass (owner)', async () => {
    const { service, deps } = buildService(makeOrder());
    const result = await service.rebroadcast(
      'order-1',
      'cust-1',
      UserRole.CUSTOMER,
    );

    expect(result.orderId).toBe('order-1');
    expect(deps.realtimeGateway.emitOrderOffered).toHaveBeenCalledTimes(1);
    expect(deps.realtimeGateway.emitNewOrderToDrivers).toHaveBeenCalledTimes(1);
    expect(deps.eventEmitter.emit).toHaveBeenCalledWith(
      'order.created',
      expect.objectContaining({ orderId: 'order-1' }),
    );
  });

  it('lets an admin rebroadcast on behalf of any customer', async () => {
    const { service, deps } = buildService(makeOrder());
    await expect(
      service.rebroadcast('order-1', 'admin-1', UserRole.ADMIN),
    ).resolves.toEqual(expect.objectContaining({ orderId: 'order-1' }));
    expect(deps.realtimeGateway.emitOrderOffered).toHaveBeenCalled();
  });

  it('throttles a second rebroadcast within the cooldown window', async () => {
    const { service } = buildService(makeOrder());
    await service.rebroadcast('order-1', 'cust-1', UserRole.CUSTOMER);
    await expect(
      service.rebroadcast('order-1', 'cust-1', UserRole.CUSTOMER),
    ).rejects.toThrow(/wait.*\d+s/i);
  });
});
