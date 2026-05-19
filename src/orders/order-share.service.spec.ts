import {
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OrderShareService } from './order-share.service';
import { OrderShareToken } from './entities/order-share-token.entity';
import { Order, OrderStatus } from './entities/order.entity';

const NOW = new Date('2026-05-19T12:00:00.000Z').getTime();

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: '11111111-2222-3333-4444-555566667777',
    customerId: 'customer-1',
    customer: { id: 'customer-1' } as never,
    driverId: 'driver-1',
    driver: {
      id: 'driver-1',
      first_name: 'Tunde',
      last_name: 'Adeyemi',
      phone: '+2348012345678',
    } as never,
    status: OrderStatus.ACCEPTED,
    pickupLatitude: 6.5244,
    pickupLongitude: 3.3792,
    deliveryLatitude: 6.4541,
    deliveryLongitude: 3.4316,
    pickupAddress: '',
    deliveryAddress: '',
    recipientName: 'X',
    recipientPhone: '+2348011111111',
    packageDescription: '',
    estimatedPrice: 0,
    createdAt: new Date('2026-05-19T11:00:00.000Z'),
    updatedAt: new Date('2026-05-19T11:00:00.000Z'),
    ...overrides,
  } as Order;
}

describe('OrderShareService (E3)', () => {
  let service: OrderShareService;
  let tokensRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let ordersRepo: { findOne: jest.Mock };
  let nowSpy: jest.SpyInstance;

  beforeEach(async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    tokensRepo = {
      findOne: jest.fn(),
      create: jest.fn((row: Partial<OrderShareToken>) => row),
      save: jest.fn((row) =>
        Promise.resolve({
          id: 'token-row-1',
          createdAt: new Date(NOW),
          ...row,
        }),
      ),
    };
    ordersRepo = { findOne: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        OrderShareService,
        {
          provide: getRepositoryToken(OrderShareToken),
          useValue: tokensRepo,
        },
        { provide: getRepositoryToken(Order), useValue: ordersRepo },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('https://admin.test') },
        },
      ],
    }).compile();
    service = mod.get(OrderShareService);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  describe('issueToken', () => {
    it('mints a 32-char hex token + share URL the first time', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(buildOrder());
      tokensRepo.findOne.mockResolvedValueOnce(null);

      const out = await service.issueToken('order-1', 'customer-1');
      expect(out.token).toMatch(/^[0-9a-f]{32}$/);
      expect(out.shareUrl).toBe(`https://admin.test/track/${out.token}`);
      expect(tokensRepo.save).toHaveBeenCalledTimes(1);
    });

    it('reuses the existing token on a second call (idempotent)', async () => {
      ordersRepo.findOne.mockResolvedValue(buildOrder());
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'existing-token-32chars-xxxxxxxxxx',
        orderId: 'order-1',
        expiresAt: null,
      });

      const out = await service.issueToken('order-1', 'customer-1');
      expect(out.token).toBe('existing-token-32chars-xxxxxxxxxx');
      expect(tokensRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not the order customer', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(buildOrder());

      await expect(
        service.issueToken('order-1', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tokensRepo.save).not.toHaveBeenCalled();
    });

    it('404s for a non-existent order', async () => {
      ordersRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.issueToken('missing', 'customer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('resolveToken', () => {
    it('returns a stripped snapshot — no PII fields appear', async () => {
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'tkn',
        orderId: 'order-1',
        expiresAt: null,
      });
      ordersRepo.findOne.mockResolvedValueOnce(buildOrder());

      const out = await service.resolveToken('tkn');

      // Stripped fields: NO customer info, NO recipient info, NO addresses,
      // NO driver phone. Only first name + stages + ETA + shortId.
      expect(out).toMatchObject({
        shortId: '66667777',
        status: OrderStatus.ACCEPTED,
        driverFirstName: 'Tunde',
        expired: false,
      });
      // Negative assertions — make sure none of these leak through if the
      // shape ever drifts.
      expect((out as Record<string, unknown>).customerId).toBeUndefined();
      expect((out as Record<string, unknown>).recipientPhone).toBeUndefined();
      expect((out as Record<string, unknown>).pickupAddress).toBeUndefined();
      expect((out as Record<string, unknown>).driverPhone).toBeUndefined();
    });

    it('includes ETA when driver location is available', async () => {
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'tkn',
        orderId: 'order-1',
        expiresAt: null,
      });
      ordersRepo.findOne.mockResolvedValueOnce(
        buildOrder({
          status: OrderStatus.IN_TRANSIT,
          driverLatitude: 6.5,
          driverLongitude: 3.4,
        }),
      );

      const out = await service.resolveToken('tkn');
      expect(out.etaMinutes).not.toBeNull();
      expect(typeof out.etaMinutes).toBe('number');
    });

    it('returns null ETA when driver location is unavailable', async () => {
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'tkn',
        orderId: 'order-1',
        expiresAt: null,
      });
      ordersRepo.findOne.mockResolvedValueOnce(
        buildOrder({ driverLatitude: undefined, driverLongitude: undefined }),
      );

      const out = await service.resolveToken('tkn');
      expect(out.etaMinutes).toBeNull();
    });

    it('GoneException once 24h have passed since delivery', async () => {
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'tkn',
        orderId: 'order-1',
        expiresAt: null,
      });
      // Delivered 25 hours before NOW.
      ordersRepo.findOne.mockResolvedValueOnce(
        buildOrder({
          status: OrderStatus.DELIVERED,
          deliveredAt: new Date(NOW - 25 * 60 * 60 * 1000),
        }),
      );

      await expect(service.resolveToken('tkn')).rejects.toBeInstanceOf(
        GoneException,
      );
    });

    it('still resolves within 24h of delivery', async () => {
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'tkn',
        orderId: 'order-1',
        expiresAt: null,
      });
      ordersRepo.findOne.mockResolvedValueOnce(
        buildOrder({
          status: OrderStatus.DELIVERED,
          deliveredAt: new Date(NOW - 12 * 60 * 60 * 1000),
        }),
      );

      const out = await service.resolveToken('tkn');
      expect(out.status).toBe(OrderStatus.DELIVERED);
    });

    it('GoneException once 24h have passed since cancellation', async () => {
      tokensRepo.findOne.mockResolvedValueOnce({
        token: 'tkn',
        orderId: 'order-1',
        expiresAt: null,
      });
      ordersRepo.findOne.mockResolvedValueOnce(
        buildOrder({
          status: OrderStatus.CANCELLED,
          deliveredAt: undefined,
          updatedAt: new Date(NOW - 25 * 60 * 60 * 1000),
        }),
      );

      await expect(service.resolveToken('tkn')).rejects.toBeInstanceOf(
        GoneException,
      );
    });

    it('404s for an unknown token', async () => {
      tokensRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.resolveToken('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
