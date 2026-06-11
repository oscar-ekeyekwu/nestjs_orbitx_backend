/* eslint-disable @typescript-eslint/no-unsafe-return --
 * chained jest mock builder returns are typed `any`. */
import { PushFanoutEventSubscribers } from './push-fanout.subscribers';
import type { OrderCreatedEvent } from './push-fanout.subscribers';

/**
 * Candidate row shape the (mocked) query builder returns — the SQL gates
 * (online / active / idle / balance >= charge / non-null coords) are
 * assumed applied by the DB; the spec drives the in-memory radius filter
 * and the fanout fan-out.
 */
interface Candidate {
  userId: string;
  currentLatitude: number;
  currentLongitude: number;
}

function buildSubscriber(candidates: Candidate[], radiusKm = 50) {
  const send = jest.fn().mockResolvedValue(undefined);
  const andWhereCalls: Array<[string, unknown]> = [];
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((clause: string, params?: unknown) => {
      andWhereCalls.push([clause, params]);
      return qb;
    }),
    select: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(candidates),
  };
  const driverProfiles = { createQueryBuilder: jest.fn(() => qb) };
  const config = { getNumber: jest.fn().mockResolvedValue(radiusKm) };

  const subscriber = new PushFanoutEventSubscribers(
    { send } as never,
    {} as never,
    driverProfiles as never,
    {} as never,
    config as never,
  );
  return { subscriber, send, andWhereCalls };
}

// Pickup at a fixed Lagos point; "near" driver ~0km, "far" driver ~50km+.
const PICKUP_LAT = 6.5;
const PICKUP_LNG = 3.3;

function event(overrides: Partial<OrderCreatedEvent> = {}): OrderCreatedEvent {
  return {
    orderId: 'o1',
    packageSize: 'medium',
    pickupAddress: 'A',
    deliveryAddress: 'B',
    estimatedPriceNaira: 1500,
    pickupLatitude: PICKUP_LAT,
    pickupLongitude: PICKUP_LNG,
    platformChargeNaira: 200,
    ...overrides,
  };
}

describe('PushFanoutEventSubscribers.onOrderCreated — proximity dispatch', () => {
  it('notifies a driver within radius of the pickup', async () => {
    const { subscriber, send } = buildSubscriber([
      { userId: 'near', currentLatitude: 6.5, currentLongitude: 3.3 },
    ]);

    await subscriber.onOrderCreated(event());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('near', expect.anything());
  });

  it('does not notify a driver outside the radius', async () => {
    const { subscriber, send } = buildSubscriber(
      // ~1 degree of latitude ≈ 111km away, well outside 50km.
      [{ userId: 'far', currentLatitude: 7.5, currentLongitude: 3.3 }],
      50,
    );

    await subscriber.onOrderCreated(event());

    expect(send).not.toHaveBeenCalled();
  });

  it('notifies only the nearby drivers from a mixed set', async () => {
    const { subscriber, send } = buildSubscriber([
      { userId: 'near', currentLatitude: 6.51, currentLongitude: 3.31 },
      { userId: 'far', currentLatitude: 7.9, currentLongitude: 3.3 },
    ]);

    await subscriber.onOrderCreated(event());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('near', expect.anything());
  });

  it('does nothing when no candidates match the SQL gate', async () => {
    const { subscriber, send } = buildSubscriber([]);

    await subscriber.onOrderCreated(event());

    expect(send).not.toHaveBeenCalled();
  });

  it('applies the wallet balance >= charge gate in the query', async () => {
    const { subscriber, andWhereCalls } = buildSubscriber([
      { userId: 'near', currentLatitude: 6.5, currentLongitude: 3.3 },
    ]);

    await subscriber.onOrderCreated(event({ platformChargeNaira: 350 }));

    const balanceClause = andWhereCalls.find(([clause]) =>
      clause.includes('balance'),
    );
    expect(balanceClause).toBeDefined();
    expect(balanceClause?.[1]).toEqual({ charge: 350 });
  });

  describe('Phase 2 — request vs direct-order push title', () => {
    it('uses the direct-order title when source is unset', async () => {
      const { subscriber, send } = buildSubscriber([
        { userId: 'near', currentLatitude: 6.5, currentLongitude: 3.3 },
      ]);

      await subscriber.onOrderCreated(event());

      expect(send).toHaveBeenCalledWith(
        'near',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'New delivery available',
          }),
          data: expect.objectContaining({ kind: 'order.created' }),
        }),
      );
    });

    it('switches title + data.kind when source=order_request', async () => {
      const { subscriber, send } = buildSubscriber([
        { userId: 'near', currentLatitude: 6.5, currentLongitude: 3.3 },
      ]);

      await subscriber.onOrderCreated(event({ source: 'order_request' }));

      expect(send).toHaveBeenCalledWith(
        'near',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'New delivery request',
          }),
          data: expect.objectContaining({
            kind: 'order_request.created',
          }),
        }),
      );
    });
  });
});
