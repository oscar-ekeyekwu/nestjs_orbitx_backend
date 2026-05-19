import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus, PackageSize } from './entities/order.entity';
import { ErrorCodes } from '../common/constants/error-codes';

function extractErrorCode(err: unknown): string | undefined {
  if (!(err instanceof BadRequestException)) return undefined;
  const res = err.getResponse();
  if (typeof res === 'object' && res !== null && 'errorCode' in res) {
    return (res as { errorCode: string }).errorCode;
  }
  return undefined;
}

function buildPendingOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'cust-1',
    driverId: null,
    status: OrderStatus.PENDING,
    packageSize: PackageSize.MEDIUM,
    acceptedAt: null,
    ...overrides,
  } as unknown as Order;
}

describe('OrdersService.acceptOrder (ARCH-12 first-accept lock)', () => {
  let ordersRepo: jest.Mocked<Repository<Order>>;
  let walletService: {
    canDriverTakeOrder: jest.Mock;
    deductSecurityDeposit: jest.Mock;
  };
  let configService: { getNumber: jest.Mock };
  let realtimeGateway: {
    emitOrderTaken: jest.Mock;
    emitOrderAccepted: jest.Mock;
    emitOrderStatusUpdate: jest.Mock;
  };
  let notifications: { notifyOrderAccepted: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let service: OrdersService;

  // Shared mutable order row simulates a single DB row. Both txns
  // serialize through manager.findOne which returns this reference.
  let sharedOrder: Order;

  beforeEach(() => {
    sharedOrder = buildPendingOrder();

    ordersRepo = {
      findOne: jest.fn().mockResolvedValue(sharedOrder),
    } as unknown as jest.Mocked<Repository<Order>>;

    walletService = {
      canDriverTakeOrder: jest.fn().mockResolvedValue(true),
      deductSecurityDeposit: jest.fn().mockResolvedValue(undefined),
    };
    configService = { getNumber: jest.fn().mockResolvedValue(0) };
    realtimeGateway = {
      emitOrderTaken: jest.fn(),
      emitOrderAccepted: jest.fn(),
      emitOrderStatusUpdate: jest.fn(),
    };
    notifications = {
      notifyOrderAccepted: jest.fn().mockResolvedValue(undefined),
    };

    // dataSource.transaction simulates pessimistic_write — callbacks
    // run sequentially with a manager that reads/writes the shared
    // sharedOrder object. The second caller observes the first
    // caller's mutation when it tries to findOne.
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown): Promise<unknown> => {
        const manager = {
          findOne: jest
            .fn()
            .mockImplementation(
              (
                _entity: unknown,
                opts: { lock?: unknown; relations?: string[] },
              ) => {
                if (opts?.relations) {
                  return Promise.resolve({
                    ...sharedOrder,
                    customer: { id: 'cust-1' },
                    driver: {
                      id: sharedOrder.driverId,
                      name: 'Tunde',
                      phone: '+234',
                    },
                  });
                }
                return Promise.resolve(sharedOrder);
              },
            ),
          save: jest.fn().mockImplementation((entity: Order) => {
            // Mutate the shared row so the next transaction sees the
            // post-commit state.
            sharedOrder = { ...sharedOrder, ...entity } as Order;
            return Promise.resolve(entity);
          }),
        };
        return Promise.resolve(cb(manager));
      }),
    };

    service = new OrdersService(
      ordersRepo,
      walletService as never,
      configService as never,
      realtimeGateway as never,
      notifications as never,
      dataSource as unknown as DataSource,
    );
  });

  it('happy path: first driver wins, order_taken broadcast fires', async () => {
    const result = await service.acceptOrder('order-1', 'driver-1');
    expect(result).toBeDefined();
    expect(sharedOrder.status).toBe(OrderStatus.ACCEPTED);
    expect(sharedOrder.driverId).toBe('driver-1');
    expect(walletService.deductSecurityDeposit).toHaveBeenCalledWith(
      'driver-1',
      'order-1',
    );
    expect(realtimeGateway.emitOrderTaken).toHaveBeenCalledWith(
      PackageSize.MEDIUM,
      'order-1',
    );
  });

  it('ORDER_004: second concurrent accept sees ACCEPTED under lock and throws', async () => {
    // First driver wins.
    await service.acceptOrder('order-1', 'driver-1');

    // Second driver tries the same order — the shared row is now
    // ACCEPTED, so the lock'd findOne returns the post-write state
    // and the service throws ORDER_004.
    let caught: unknown;
    try {
      await service.acceptOrder('order-1', 'driver-2');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(extractErrorCode(caught)).toBe(ErrorCodes.ORDER_004);
    // Loser must NOT have been charged the deposit.
    expect(walletService.deductSecurityDeposit).toHaveBeenCalledTimes(1);
    expect(walletService.deductSecurityDeposit).toHaveBeenCalledWith(
      'driver-1',
      'order-1',
    );
  });

  it('insufficient balance rejects BEFORE the lock — no transaction opened', async () => {
    walletService.canDriverTakeOrder.mockResolvedValueOnce(false);
    configService.getNumber.mockResolvedValueOnce(500);

    await expect(
      service.acceptOrder('order-1', 'broke-driver'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('404 path: missing order surfaces NotFoundException inside the lock', async () => {
    // Force the locked findOne to return null even though the
    // pre-lock check found something. Simulates a row vanishing
    // between the pre-fetch and the lock (delete by admin).
    dataSource.transaction = jest.fn(
      (cb: (m: unknown) => unknown): Promise<unknown> => {
        const manager = {
          findOne: jest.fn().mockResolvedValue(null),
          save: jest.fn(),
        };
        return Promise.resolve(cb(manager));
      },
    );
    service = new OrdersService(
      ordersRepo,
      walletService as never,
      configService as never,
      realtimeGateway as never,
      notifications as never,
      dataSource as unknown as DataSource,
    );

    await expect(service.acceptOrder('missing', 'd-1')).rejects.toThrow(
      'Order not found',
    );
  });
});
