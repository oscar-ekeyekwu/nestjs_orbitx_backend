import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './entities/order.entity';
import { UserRole } from '../common/enums/user-role.enum';

/**
 * E2 — verify the caller-scoping rules on findOneScoped. The endpoint
 * loads `driver` with the order; without this gate any authenticated
 * user could fetch another order and read the driver's phone.
 */
describe('OrdersService.findOneScoped (E2 — auth gate)', () => {
  const baseOrder: Partial<Order> = {
    id: 'order-1',
    customerId: 'customer-1',
    driverId: 'driver-1',
    status: OrderStatus.ACCEPTED,
  };

  function buildService(overrides: Partial<Order> = {}): OrdersService {
    const findOne = jest.fn().mockResolvedValue({ ...baseOrder, ...overrides });
    const ordersRepo = { findOne } as unknown as Parameters<
      typeof Reflect.set
    >[0];
    // Only findOne is exercised here, so the other deps can be left as no-ops.
    return new OrdersService(
      ordersRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('allows the order customer to fetch their own order', async () => {
    const service = buildService();
    const out = await service.findOneScoped(
      'order-1',
      'customer-1',
      UserRole.CUSTOMER,
    );
    expect(out.id).toBe('order-1');
  });

  it('allows the assigned driver to fetch the order', async () => {
    const service = buildService();
    const out = await service.findOneScoped(
      'order-1',
      'driver-1',
      UserRole.DRIVER,
    );
    expect(out.id).toBe('order-1');
  });

  it('allows admins to fetch any order', async () => {
    const service = buildService();
    const out = await service.findOneScoped(
      'order-1',
      'admin-1',
      UserRole.ADMIN,
    );
    expect(out.id).toBe('order-1');
  });

  it('rejects a customer who does not own the order', async () => {
    const service = buildService();
    await expect(
      service.findOneScoped('order-1', 'customer-2', UserRole.CUSTOMER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a driver who was not assigned to the order', async () => {
    const service = buildService();
    await expect(
      service.findOneScoped('order-1', 'driver-2', UserRole.DRIVER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a driver fetching a pending order with no driver assigned', async () => {
    const service = buildService({
      driverId: undefined,
      status: OrderStatus.PENDING,
    });
    await expect(
      service.findOneScoped('order-1', 'driver-1', UserRole.DRIVER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('surfaces NotFoundException untouched for missing orders', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const ordersRepo = { findOne } as unknown as Parameters<
      typeof Reflect.set
    >[0];
    const service = new OrdersService(
      ordersRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.findOneScoped('missing', 'customer-1', UserRole.CUSTOMER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
