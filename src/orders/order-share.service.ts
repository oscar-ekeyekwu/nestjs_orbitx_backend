import {
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';
import { OrderShareToken } from './entities/order-share-token.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { haversineKm } from '../common/geo';

// Coarse driver-speed assumption shared with the mobile client (lib/geo.ts).
// Kept here as a literal rather than imported from a sibling so the share
// service stays independent of the orders pricing/ETA chain.
const DRIVER_SPEED_KMH = 30;

function etaMinutes(distanceKm: number): number {
  if (distanceKm <= 0) return 0;
  return Math.ceil((distanceKm / DRIVER_SPEED_KMH) * 60);
}

const TOKEN_BYTES = 24; // 24 bytes -> 32 hex chars; collision-resistant.
const POST_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000; // 24h after delivery / cancellation.

/**
 * Public snapshot fields a non-authenticated reader receives via
 * GET /track/:token. The shape strips PII per E3 AC: NO recipient
 * names / phones, NO customer details, NO driver phone, NO addresses
 * — just enough to communicate progress + ETA.
 */
export interface PublicTrackingSnapshot {
  shortId: string;
  status: OrderStatus;
  stages: {
    status: 'pending' | 'accepted' | 'picked_up' | 'in_transit' | 'delivered';
    at: string | null;
  }[];
  driverFirstName: string | null;
  etaMinutes: number | null;
  expired: false;
}

@Injectable()
export class OrderShareService {
  constructor(
    @InjectRepository(OrderShareToken)
    private readonly tokensRepo: Repository<OrderShareToken>,
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Issue (or reuse) the share token for an order. Idempotent — calling
   * twice in the order's lifetime returns the same token.
   */
  async issueToken(
    orderId: string,
    callerUserId: string,
  ): Promise<{ token: string; shareUrl: string }> {
    const order = await this.ordersRepo.findOne({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.customerId !== callerUserId) {
      throw new ForbiddenException(
        'Only the order customer can issue a share token',
      );
    }

    let row = await this.tokensRepo.findOne({ where: { orderId } });
    if (!row) {
      row = this.tokensRepo.create({
        orderId,
        token: this.mintToken(),
        // No hard expiry while in progress — the public reader enforces
        // the deliveredAt + 24h cutoff dynamically.
        expiresAt: null,
      });
      row = await this.tokensRepo.save(row);
    }

    return {
      token: row.token,
      shareUrl: this.buildShareUrl(row.token),
    };
  }

  /**
   * Public reader. Throws GoneException once 24h have elapsed since
   * the order completed (delivered or cancelled). Never throws on a
   * still-in-progress order. Never leaks PII.
   */
  async resolveToken(token: string): Promise<PublicTrackingSnapshot> {
    const row = await this.tokensRepo.findOne({ where: { token } });
    if (!row) {
      throw new NotFoundException('Share link not found');
    }

    // Hard cutoff sanity check — only meaningful if a future feature
    // sets expiresAt explicitly. Today it's always null on creation.
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw new GoneException('Share link has expired');
    }

    const order = await this.ordersRepo.findOne({
      where: { id: row.orderId },
      relations: ['driver'],
    });
    if (!order) {
      throw new NotFoundException('Share link not found');
    }

    const completedAt =
      order.deliveredAt ??
      (order.status === OrderStatus.CANCELLED ? order.updatedAt : null);
    if (
      completedAt &&
      Date.now() - new Date(completedAt).getTime() > POST_DELIVERY_TTL_MS
    ) {
      throw new GoneException('Share link has expired');
    }

    return this.buildSnapshot(order);
  }

  private buildSnapshot(order: Order): PublicTrackingSnapshot {
    const stages: PublicTrackingSnapshot['stages'] = [
      { status: 'pending', at: this.toIso(order.createdAt) },
      { status: 'accepted', at: this.toIso(order.acceptedAt) },
      { status: 'picked_up', at: this.toIso(order.pickedUpAt) },
      { status: 'in_transit', at: this.toIso(order.pickedUpAt) },
      { status: 'delivered', at: this.toIso(order.deliveredAt) },
    ];

    const driverFirstName = order.driver?.first_name?.trim() || null;

    return {
      shortId: order.id.slice(-8),
      status: order.status,
      stages,
      driverFirstName,
      etaMinutes: this.computeEta(order),
      expired: false,
    };
  }

  private computeEta(order: Order): number | null {
    const driverLat = order.driverLatitude;
    const driverLng = order.driverLongitude;
    if (driverLat == null || driverLng == null) return null;

    const targetingDropoff =
      order.status === OrderStatus.PICKED_UP ||
      order.status === OrderStatus.IN_TRANSIT;
    const tLat = targetingDropoff
      ? order.deliveryLatitude
      : order.pickupLatitude;
    const tLng = targetingDropoff
      ? order.deliveryLongitude
      : order.pickupLongitude;
    if (tLat == null || tLng == null) return null;

    return etaMinutes(haversineKm(driverLat, driverLng, tLat, tLng));
  }

  private toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
  }

  private mintToken(): string {
    return crypto.randomBytes(TOKEN_BYTES).toString('hex').slice(0, 32);
  }

  private buildShareUrl(token: string): string {
    const base =
      this.configService.get<string>('SHARE_BASE_URL') ||
      'https://admin.orbit.app';
    return `${base.replace(/\/+$/, '')}/track/${token}`;
  }
}
