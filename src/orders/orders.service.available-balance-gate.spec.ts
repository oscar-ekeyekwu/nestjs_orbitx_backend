import { DataSource, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus, PackageSize } from './entities/order.entity';
import { naira, type Naira } from '../common/money';

function buildOrder(id: string, charge: Naira | null): Order {
  return {
    id,
    status: OrderStatus.PENDING,
    packageSize: PackageSize.MEDIUM,
    // Co-located with the querying driver so the radius filter passes and
    // only the balance filter decides visibility.
    pickupLatitude: 6.5,
    pickupLongitude: 3.3,
    platformCharge: charge,
  } as unknown as Order;
}

function buildService(orders: Order[], balance: string): OrdersService {
  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(orders),
  };
  const ordersRepo = {
    createQueryBuilder: jest.fn(() => qb),
  } as unknown as Repository<Order>;
  const walletService = {
    getWalletByUserId: jest.fn().mockResolvedValue({ balance: naira(balance) }),
  };
  const configService = { getNumber: jest.fn().mockResolvedValue(50) };

  return new OrdersService(
    ordersRepo,
    walletService as never,
    configService as never,
    {} as never,
    {} as never,
    { emit: jest.fn() } as never,
    {} as never,
    {} as unknown as DataSource,
  );
}

describe('OrdersService.findAvailableOrders — balance gate', () => {
  it('hides orders whose charge exceeds the driver balance', async () => {
    const cheap = buildOrder('cheap', naira('100'));
    const pricey = buildOrder('pricey', naira('1000'));
    const service = buildService([cheap, pricey], '500');

    const result = await service.findAvailableOrders(6.5, 3.3, 'driver-1');

    expect(result.map((o) => o.id)).toEqual(['cheap']);
  });

  it('treats a null platformCharge as zero (visible for back-compat)', async () => {
    const legacy = buildOrder('legacy', null);
    const service = buildService([legacy], '0');

    const result = await service.findAvailableOrders(6.5, 3.3, 'driver-1');

    expect(result.map((o) => o.id)).toEqual(['legacy']);
  });

  it('shows all affordable orders when the balance covers them', async () => {
    const a = buildOrder('a', naira('100'));
    const b = buildOrder('b', naira('200'));
    const service = buildService([a, b], '1000');

    const result = await service.findAvailableOrders(6.5, 3.3, 'driver-1');

    expect(result.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });
});
