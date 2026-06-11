import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { OrderRequestsService } from './order-requests.service';
import {
  OrderRequest,
  OrderRequestStatus,
} from './entities/order-request.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
  DispatchOfferType,
} from './entities/dispatch-offer.entity';
import { Order, PackageSize } from '../orders/entities/order.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { naira } from '../common/money';

/**
 * Shared in-memory state that the transaction mock mutates. Lets us
 * test the auto-resolve / second-quote-loser path realistically
 * without a real DB.
 */
type State = {
  request: OrderRequest;
  offers: DispatchOffer[];
  orders: Order[];
};

function makeRequest(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    id: 'req-1',
    customerId: 'cust-1',
    status: OrderRequestStatus.OPEN,
    pickupLatitude: 6.5,
    pickupLongitude: 3.3,
    pickupAddress: '1 Pickup',
    deliveryLatitude: 6.6,
    deliveryLongitude: 3.4,
    deliveryAddress: '2 Delivery',
    recipientName: 'Mark',
    recipientPhone: '+234',
    packageDescription: 'Books',
    packageWeight: null,
    packageSize: PackageSize.MEDIUM,
    deliveryNotes: null,
    quotedPrice: naira('1500'),
    insuranceFee: naira('100'),
    platformCharge: naira('200'),
    distanceKm: 5,
    expiresAt: new Date(Date.now() + 300_000),
    resolvedOrderId: null,
    resolvedOfferId: null,
    eligibleDriversAtBroadcast: 5,
    ...overrides,
  } as unknown as OrderRequest;
}

function buildService(state: State): {
  service: OrderRequestsService;
  walletService: {
    canDriverCoverCharge: jest.Mock;
    holdOrderCharge: jest.Mock;
    computeOrderCharge: jest.Mock;
  };
  realtimeGateway: {
    emitRequestCreated: jest.Mock;
    emitOfferUpdate: jest.Mock;
    emitRequestResolved: jest.Mock;
    countEligibleDrivers: jest.Mock;
  };
  ordersService: { quote: jest.Mock };
  eventEmitter: { emit: jest.Mock };
} {
  const requestsRepo = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === state.request.id ? state.request : null,
    ),
    create: jest.fn((data: Partial<OrderRequest>) => ({
      ...data,
    })) as unknown as jest.Mock,
    save: jest.fn(async (entity: OrderRequest) => {
      const saved = { ...state.request, ...entity, id: state.request.id };
      state.request = saved as OrderRequest;
      return saved;
    }),
    find: jest.fn(async () =>
      state.request.status === OrderRequestStatus.OPEN ? [state.request] : [],
    ),
  } as unknown as Repository<OrderRequest>;

  const offersRepo = {
    findOne: jest.fn(
      async ({
        where,
      }: {
        where: Partial<DispatchOffer> & { driverId?: string };
      }) => {
        const driverId = where.driverId;
        const status = where.status;
        return (
          state.offers.find(
            (o) =>
              (driverId === undefined || o.driverId === driverId) &&
              (status === undefined || o.status === status),
          ) ?? null
        );
      },
    ),
    find: jest.fn(async () => state.offers),
    create: jest.fn((data: Partial<DispatchOffer>) => ({
      id: `offer-${state.offers.length + 1}`,
      ...data,
    })) as unknown as jest.Mock,
    save: jest.fn(async (entity: DispatchOffer) => {
      const idx = state.offers.findIndex((o) => o.id === entity.id);
      if (idx >= 0) state.offers[idx] = { ...state.offers[idx], ...entity };
      else state.offers.push(entity as DispatchOffer);
      return entity;
    }),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    })),
  } as unknown as Repository<DispatchOffer>;

  const ordersRepo = {} as Repository<Order>;

  const walletService = {
    canDriverCoverCharge: jest.fn().mockResolvedValue(true),
    holdOrderCharge: jest.fn().mockResolvedValue(null),
    computeOrderCharge: jest.fn().mockResolvedValue(naira('200')),
  };

  const realtimeGateway = {
    emitRequestCreated: jest.fn(),
    emitOfferUpdate: jest.fn(),
    emitRequestResolved: jest.fn(),
    countEligibleDrivers: jest.fn().mockResolvedValue(5),
  };

  const ordersService = {
    quote: jest.fn().mockResolvedValue({
      estimatedPrice: naira('1500'),
      insuranceFee: naira('100'),
      platformCharge: naira('200'),
      distanceKm: 5,
    }),
  };

  const configService = {
    getNumber: jest.fn(async (key: string, def: number) => def),
  };

  const eventEmitter = { emit: jest.fn() };

  // Transaction mock — single manager that proxies through to our
  // shared state. Pessimistic locks are not actually applied; the
  // tests sequence operations explicitly to avoid races.
  const dataSource = {
    transaction: jest.fn(async (cb: (m: unknown) => unknown) => {
      const manager = {
        findOne: jest.fn(
          async (
            entity: unknown,
            opts: {
              where?: { id?: string; requestId?: string; driverId?: string; status?: string };
            },
          ) => {
            if (entity === OrderRequest) {
              return opts.where?.id === state.request.id
                ? state.request
                : null;
            }
            if (entity === DispatchOffer) {
              const id = opts.where?.id;
              const driverId = opts.where?.driverId;
              const status = opts.where?.status;
              return (
                state.offers.find(
                  (o) =>
                    (id === undefined || o.id === id) &&
                    (driverId === undefined || o.driverId === driverId) &&
                    (status === undefined || o.status === status),
                ) ?? null
              );
            }
            return null;
          },
        ),
        save: jest.fn(async (entity: any) => {
          if (entity?.requestId !== undefined && entity?.driverId !== undefined && entity?.type !== undefined) {
            // It's a DispatchOffer
            const idx = state.offers.findIndex((o) => o.id === entity.id);
            if (idx >= 0) {
              state.offers[idx] = { ...state.offers[idx], ...entity };
            } else {
              state.offers.push(entity as DispatchOffer);
            }
            return entity;
          }
          if (entity?.customerId && entity?.status && 'pickupLatitude' in entity) {
            if ('quotedPrice' in entity) {
              state.request = { ...state.request, ...entity };
              return state.request;
            }
            // Order
            state.orders.push(entity as Order);
            return entity;
          }
          return entity;
        }),
        create: jest.fn((entityCls: unknown, data: any) => ({
          id:
            entityCls === Order
              ? `ord-${state.orders.length + 1}`
              : `offer-${state.offers.length + 1}`,
          ...data,
        })) as unknown as jest.Mock,
        createQueryBuilder: jest.fn(() => ({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 0 }),
        })),
      };
      return cb(manager);
    }),
  } as unknown as DataSource;

  const service = new OrderRequestsService(
    requestsRepo,
    offersRepo,
    ordersRepo,
    ordersService as never,
    walletService as never,
    configService as never,
    realtimeGateway as never,
    eventEmitter as never,
    dataSource,
  );

  return {
    service,
    walletService,
    realtimeGateway,
    ordersService,
    eventEmitter,
  };
}

describe('OrderRequestsService', () => {
  let state: State;

  beforeEach(() => {
    state = {
      request: makeRequest(),
      offers: [],
      orders: [],
    };
  });

  describe('submitOffer — quote-accept auto-resolves', () => {
    it('creates an Order with ACCEPTED status, marks request RESOLVED, fires request_resolved', async () => {
      const { service, realtimeGateway, walletService } = buildService(state);

      const result = await service.submitOffer('req-1', 'driver-1', {
        type: DispatchOfferType.QUOTE_ACCEPT,
        etaSeconds: 600,
      });

      expect(result.resolvedOrderId).toBeTruthy();
      expect(state.orders).toHaveLength(1);
      expect(state.orders[0].driverId).toBe('driver-1');
      expect(state.request.status).toBe(OrderRequestStatus.RESOLVED);
      expect(realtimeGateway.emitRequestResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'resolved',
          orderId: result.resolvedOrderId,
          winningDriverId: 'driver-1',
        }),
      );
      // Wallet hold happens AFTER the txn commits.
      expect(walletService.holdOrderCharge).toHaveBeenCalledWith(
        'driver-1',
        result.resolvedOrderId,
        expect.anything(),
      );
    });
  });

  describe('submitOffer — counter offer queues', () => {
    it('persists a pending counter offer without resolving the request', async () => {
      const { service, realtimeGateway } = buildService(state);

      const result = await service.submitOffer('req-1', 'driver-1', {
        type: DispatchOfferType.COUNTER,
        etaSeconds: 600,
        price: 2000,
        reason: 'rain',
      });

      expect(result.resolvedOrderId).toBeNull();
      expect(state.offers).toHaveLength(1);
      expect(state.offers[0].status).toBe(DispatchOfferStatus.PENDING);
      expect(state.request.status).toBe(OrderRequestStatus.OPEN);
      expect(realtimeGateway.emitOfferUpdate).toHaveBeenCalledWith(
        'cust-1',
        expect.objectContaining({ requestId: 'req-1', kind: 'submitted' }),
      );
    });

    it('rejects a counter price below the 80% floor', async () => {
      const { service } = buildService(state);

      // 1500 × 0.8 = 1200. 1000 is below floor.
      await expect(
        service.submitOffer('req-1', 'driver-1', {
          type: DispatchOfferType.COUNTER,
          etaSeconds: 600,
          price: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a counter price above the 2× ceiling', async () => {
      const { service } = buildService(state);

      // 1500 × 2.0 = 3000. 3500 exceeds.
      await expect(
        service.submitOffer('req-1', 'driver-1', {
          type: DispatchOfferType.COUNTER,
          etaSeconds: 600,
          price: 3500,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('submitOffer — guards', () => {
    it('rejects when the request is no longer OPEN', async () => {
      state.request.status = OrderRequestStatus.RESOLVED;
      const { service } = buildService(state);

      await expect(
        service.submitOffer('req-1', 'driver-1', {
          type: DispatchOfferType.QUOTE_ACCEPT,
          etaSeconds: 600,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the request has expired', async () => {
      state.request.expiresAt = new Date(Date.now() - 1000);
      const { service } = buildService(state);

      await expect(
        service.submitOffer('req-1', 'driver-1', {
          type: DispatchOfferType.QUOTE_ACCEPT,
          etaSeconds: 600,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a driver whose wallet cannot cover platformCharge + insurance', async () => {
      const built = buildService(state);
      built.walletService.canDriverCoverCharge.mockResolvedValueOnce(false);

      await expect(
        built.service.submitOffer('req-1', 'driver-1', {
          type: DispatchOfferType.QUOTE_ACCEPT,
          etaSeconds: 600,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(state.offers).toHaveLength(0);
    });

    it('rejects a driver who already has a pending offer on another request', async () => {
      state.offers.push({
        id: 'old-offer',
        requestId: 'other-request',
        driverId: 'driver-1',
        status: DispatchOfferStatus.PENDING,
      } as DispatchOffer);

      const { service } = buildService(state);

      await expect(
        service.submitOffer('req-1', 'driver-1', {
          type: DispatchOfferType.QUOTE_ACCEPT,
          etaSeconds: 600,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('acceptOffer', () => {
    it('resolves the request and creates an Order with the counter offer’s price', async () => {
      state.offers.push({
        id: 'offer-1',
        requestId: 'req-1',
        driverId: 'driver-2',
        type: DispatchOfferType.COUNTER,
        status: DispatchOfferStatus.PENDING,
        price: naira('2000'),
        etaSeconds: 600,
        reason: 'rain',
        offerExpiresAt: new Date(Date.now() + 60_000),
      } as unknown as DispatchOffer);

      const { service, walletService } = buildService(state);

      const result = await service.acceptOffer('req-1', 'offer-1', 'cust-1');
      expect(result.orderId).toBeTruthy();
      expect(state.request.status).toBe(OrderRequestStatus.RESOLVED);
      expect(state.orders[0].driverId).toBe('driver-2');
      expect(walletService.holdOrderCharge).toHaveBeenCalledWith(
        'driver-2',
        result.orderId,
        expect.anything(),
      );
    });

    it('rejects when caller is not the owner', async () => {
      state.offers.push({
        id: 'offer-1',
        requestId: 'req-1',
        driverId: 'driver-2',
        type: DispatchOfferType.COUNTER,
        status: DispatchOfferStatus.PENDING,
        price: naira('2000'),
        etaSeconds: 600,
        reason: null,
        offerExpiresAt: new Date(Date.now() + 60_000),
      } as unknown as DispatchOffer);

      const { service } = buildService(state);

      await expect(
        service.acceptOffer('req-1', 'offer-1', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when the offer has expired', async () => {
      state.offers.push({
        id: 'offer-1',
        requestId: 'req-1',
        driverId: 'driver-2',
        type: DispatchOfferType.COUNTER,
        status: DispatchOfferStatus.PENDING,
        price: naira('2000'),
        etaSeconds: 600,
        reason: null,
        offerExpiresAt: new Date(Date.now() - 1_000),
      } as unknown as DispatchOffer);

      const { service } = buildService(state);

      await expect(
        service.acceptOffer('req-1', 'offer-1', 'cust-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('marks request CANCELLED + emits request_resolved with outcome=cancelled', async () => {
      const { service, realtimeGateway } = buildService(state);

      await service.cancel('req-1', 'cust-1');

      expect(state.request.status).toBe(OrderRequestStatus.CANCELLED);
      expect(realtimeGateway.emitRequestResolved).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'cancelled' }),
      );
    });

    it('rejects non-owner cancellation', async () => {
      const { service } = buildService(state);
      await expect(
        service.cancel('req-1', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the request does not exist', async () => {
      const { service } = buildService({
        ...state,
        request: makeRequest({ id: 'other' }),
      });
      await expect(service.cancel('req-1', 'cust-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findOneScoped', () => {
    it('returns the request for the owner', async () => {
      const { service } = buildService(state);
      const found = await service.findOneScoped(
        'req-1',
        'cust-1',
        UserRole.CUSTOMER,
      );
      expect(found.id).toBe('req-1');
    });

    it('returns the request for an admin', async () => {
      const { service } = buildService(state);
      const found = await service.findOneScoped(
        'req-1',
        'admin-1',
        UserRole.ADMIN,
      );
      expect(found.id).toBe('req-1');
    });

    it('forbids a stranger', async () => {
      const { service } = buildService(state);
      await expect(
        service.findOneScoped('req-1', 'someone-else', UserRole.CUSTOMER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
