import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushFanoutService } from './push-fanout.service';
import type {
  ExpiredEvent,
  ExpiringSoonEvent,
  OwnerSuspendedEvent,
} from '../documents/document-expiry.cron';
import { DocumentOwnerType } from '../documents/entities/document.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import {
  DriverProfile,
  DriverVerificationStatus,
} from '../drivers/entities/driver-profile.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { haversineKm } from '../common/geo';

// I6 — payload shape published by IncidentsService.
export interface IncidentRaisedEvent {
  incidentId: string;
  orderId: string;
  driverId: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface IncidentAcknowledgedEvent {
  incidentId: string;
  orderId: string;
  driverId: string;
  timeToAcknowledgeMs: number;
}

/**
 * C5 / D4 — review-decision events emitted post-commit by services
 * that move an entity through its state machine. ARCH-10 listens
 * for these to fan out push notifications to the affected user.
 */
export interface ReviewEvent {
  /**
   * Direct push target. For documents owned by a user this is the
   * owner; for driver verification this is the driver's user_id.
   * Vehicle / company reviews fan out to the appropriate user (or
   * users) when D2 / D3 / D4 wire those up.
   */
  userId: string;
  reason?: string | null;
}

// PAY-1 — wallet funding event emitted post-commit by the Paystack
// webhook handler after addFunds succeeds. The push subscriber
// renders a "Wallet funded" notification; RealtimeGateway emits the
// same event as a socket message so the mobile wallet refreshes
// without pull-to-refresh.
export interface WalletFundedEvent {
  userId: string;
  amountNaira: number;
  reference: string;
}

// Order-created event emitted post-commit by OrdersService. The push
// subscriber fans out a "new delivery available" notification to
// every active+online driver so they don't have to keep the app
// foregrounded to see new work.
export interface OrderCreatedEvent {
  orderId: string;
  packageSize: string;
  pickupAddress: string;
  deliveryAddress: string;
  estimatedPriceNaira: number;
  // Proximity + balance dispatch inputs.
  pickupLatitude: number;
  pickupLongitude: number;
  platformChargeNaira: number;
  // Phase 2 dispatch — set to 'order_request' when this event is
  // emitted from the OrderRequest flow (not a direct order create).
  // Lets the push subscriber switch the title from "New order" to
  // "New delivery request" without splitting into a second event.
  source?: 'order' | 'order_request';
}

// Phase 3 — customer ticked "I've sent the transfer". Emitted by
// OrdersService.markCustomerPaid; the push subscriber forwards a
// notification to the assigned driver so they check their bank app.
export interface OrderCustomerMarkedPaidEvent {
  orderId: string;
  driverId: string;
  amountNaira: number;
  customerName: string;
  /** Phase 3 — true when the customer attached a transfer
   *  screenshot. Lets the push body distinguish a bare claim from
   *  a substantiated one. */
  hasProof?: boolean;
}

// Phase 3 — driver confirmed receipt. Emitted by
// OrdersService.confirmPaymentReceived; the push subscriber forwards
// a confirmation to the customer.
export interface OrderPaymentConfirmedEvent {
  orderId: string;
  customerId: string;
  amountNaira: number;
}

/**
 * ARCH-10 — event-to-push subscriber. Lives in NotificationsModule so
 * the routing logic is colocated with the channel. Each handler keeps
 * the translation logic trivial — title/body string composition plus
 * a `void send(...)` call.
 *
 * The fanout service is fire-and-forget (NFR-P1). The handlers don't
 * `await` it on the request path — a slow Firebase response can't
 * block the next subscriber.
 */
@Injectable()
export class PushFanoutEventSubscribers {
  private readonly logger = new Logger(PushFanoutEventSubscribers.name);

  constructor(
    private readonly fanout: PushFanoutService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    private readonly config: SystemConfigService,
  ) {}

  // ────────────────────────────────── C4 expiry cron events
  @OnEvent('document.expiring_soon')
  onExpiringSoon(event: ExpiringSoonEvent): void {
    const target = this.resolveUserId(event.ownerType, event.ownerId);
    if (!target) return;
    void this.fanout.send(target, {
      notification: {
        title: 'Document expiring soon',
        body: `Your ${humanizeDocType(event.type)} expires in ${event.daysRemaining} day(s). Re-upload to keep working.`,
      },
      data: {
        kind: 'document.expiring_soon',
        documentId: event.documentId,
        daysRemaining: String(event.daysRemaining),
        expiryDate: event.expiryDate,
      },
    });
  }

  @OnEvent('document.expired')
  onExpired(event: ExpiredEvent): void {
    const target = this.resolveUserId(event.ownerType, event.ownerId);
    if (!target) return;
    void this.fanout.send(target, {
      notification: {
        title: 'Document expired',
        body: `Your ${humanizeDocType(event.type)} expired on ${event.expiryDate}. Account features that depend on it are paused until you re-upload.`,
      },
      data: {
        kind: 'document.expired',
        documentId: event.documentId,
        expiryDate: event.expiryDate,
      },
    });
  }

  @OnEvent('owner.suspended_docs_expired')
  onOwnerSuspended(event: OwnerSuspendedEvent): void {
    const target = this.resolveUserId(event.ownerType, event.ownerId);
    if (!target) return;
    void this.fanout.send(target, {
      notification: {
        title: 'Account suspended',
        body: 'Your account has been suspended because a required document expired. Re-upload to restore service.',
      },
      data: {
        kind: 'owner.suspended_docs_expired',
        triggeringDocumentId: event.triggeringDocumentId,
      },
    });
  }

  // ────────────────────────────────── C5 review-decision events
  @OnEvent('document.approved')
  onDocumentApproved(event: ReviewEvent & { documentId: string }): void {
    void this.fanout.send(event.userId, {
      notification: {
        title: 'Document approved',
        body: 'Your document has been approved by an admin.',
      },
      data: { kind: 'document.approved', documentId: event.documentId },
    });
  }

  @OnEvent('document.rejected')
  onDocumentRejected(event: ReviewEvent & { documentId: string }): void {
    void this.fanout.send(event.userId, {
      notification: {
        title: 'Document rejected',
        body:
          event.reason?.trim() ||
          'Your document was rejected. Tap to see details.',
      },
      data: { kind: 'document.rejected', documentId: event.documentId },
    });
  }

  @OnEvent('driver.approved')
  onDriverApproved(event: ReviewEvent): void {
    void this.fanout.send(event.userId, {
      notification: {
        title: 'Verification approved',
        body: "You're cleared to go online. Open Orbit to start accepting orders.",
      },
      data: { kind: 'driver.approved' },
    });
  }

  @OnEvent('driver.rejected')
  onDriverRejected(event: ReviewEvent): void {
    void this.fanout.send(event.userId, {
      notification: {
        title: 'Verification needs more info',
        body:
          event.reason?.trim() ||
          'Your driver verification was rejected. Re-submit with the requested updates.',
      },
      data: { kind: 'driver.rejected' },
    });
  }

  // ────────────────────────────────── Order broadcast events
  @OnEvent('order.created')
  async onOrderCreated(event: OrderCreatedEvent): Promise<void> {
    // Proximity + balance dispatch. Notify only online/active/idle drivers
    // who (a) have a known location within ORDER_DELIVERY_RADIUS_KM of the
    // pickup and (b) hold enough wallet balance to cover the order's
    // platform charge. The SQL narrows by the gates we can express in the
    // DB (online/active/idle, balance, non-null coords); the radius is
    // applied in memory against the already-small candidate set. Drivers
    // with no known location are SKIPPED — we can't proximity-filter them,
    // and including everyone would defeat the purpose of this fix.
    const radiusKm = await this.config.getNumber(
      ConfigKey.ORDER_DELIVERY_RADIUS_KM,
      50,
    );
    // MAX_ORDERS_PER_DRIVER (admin-tunable; default 1) — when set,
    // a driver already at the cap shouldn't get pinged with new
    // work. Counted live off the orders table so a stuck
    // isOnDelivery flag can't keep a freed driver out of the pool
    // and a missing flag can't sneak an at-cap driver in.
    const cap = await this.config.getNumber(
      ConfigKey.MAX_ORDERS_PER_DRIVER,
      1,
    );

    const candidates: Array<{
      userId: string;
      currentLatitude: string | number;
      currentLongitude: string | number;
    }> = await this.driverProfiles
      .createQueryBuilder('dp')
      .innerJoin(Wallet, 'w', 'w."userId" = dp."userId"')
      .innerJoin(
        '"wallet_balances"',
        'wb',
        'wb."wallet_id" = w."id"',
      )
      .where('dp."isOnline" = true')
      // Widened — Phase 3 — to include APPROVED. The chained
      // approved → active transition can fail (admin patches that
      // skip the state machine, partial migrations) and the result
      // is a driver who's online + funded but invisible to dispatch.
      // The Live Drivers admin page already widened to match; this
      // brings the push fanout in line so a "stuck approved" driver
      // can still receive orders. Suspended/rejected/setup states
      // stay excluded.
      .andWhere('dp."verificationStatus" IN (:...statuses)', {
        statuses: [
          DriverVerificationStatus.APPROVED,
          DriverVerificationStatus.ACTIVE,
        ],
      })
      .andWhere('dp."isOnDelivery" = false')
      .andWhere('dp."currentLatitude" IS NOT NULL')
      .andWhere('dp."currentLongitude" IS NOT NULL')
      .andWhere('wb."balance" >= :charge', {
        charge: event.platformChargeNaira,
      })
      // MAX_ORDERS_PER_DRIVER — exclude drivers whose live active-order
      // count is already at the cap. The subquery is grouped so it
      // counts per-driver. cap <= 0 disables this gate entirely.
      .andWhere(
        Number.isFinite(cap) && cap > 0
          ? `(
              SELECT COUNT(*) FROM "orders" o
              WHERE o."driverId" = dp."userId"
                AND o."status" IN ('accepted', 'picked_up', 'in_transit')
            ) < :activeOrderCap`
          : '1 = 1',
        { activeOrderCap: cap },
      )
      .select([
        'dp."userId" AS "userId"',
        'dp."currentLatitude" AS "currentLatitude"',
        'dp."currentLongitude" AS "currentLongitude"',
      ])
      .getRawMany();

    const nearby = candidates.filter(
      (d) =>
        haversineKm(
          event.pickupLatitude,
          event.pickupLongitude,
          Number(d.currentLatitude),
          Number(d.currentLongitude),
        ) <= radiusKm,
    );

    if (nearby.length === 0) {
      // Per-gate diagnostic — when 0 drivers match, the broad warning
      // doesn't tell ops WHICH gate killed it. This second query
      // counts how many drivers satisfy each gate independently, so
      // a log read pinpoints the bottleneck in one line.
      const breakdown = await this.diagnoseEligibilityFailure(
        event.platformChargeNaira,
      );
      this.logger.warn(
        `order.created ${event.orderId} packageSize=${event.packageSize} — no eligible drivers ` +
          `(online+(APPROVED|ACTIVE)+!isOnDelivery, within ${radiusKm}km of pickup, balance >= ₦${event.platformChargeNaira}). ` +
          `${candidates.length} matched the balance+status gate but none were within radius. ` +
          `Driver pool breakdown — total=${breakdown.total} online=${breakdown.online} ` +
          `approvedOrActive=${breakdown.approvedOrActive} notOnDelivery=${breakdown.notOnDelivery} ` +
          `withGps=${breakdown.withGps} fundedFor₦${event.platformChargeNaira}=${breakdown.funded}. ` +
          `Check driver_profiles location/online state and DRIVER_CHARGE_* config.`,
      );
      return;
    }
    this.logger.log(
      `order.created ${event.orderId} packageSize=${event.packageSize} → fanning out push to ${nearby.length} ` +
        `nearby, funded driver(s) (within ${radiusKm}km, balance >= ₦${event.platformChargeNaira}).`,
    );
    const priceText = `₦${Number(event.estimatedPriceNaira).toLocaleString(
      'en-NG',
      { minimumFractionDigits: 0, maximumFractionDigits: 0 },
    )}`;
    // Phase 2 — switch the title + tap-target when the event came
    // from the OrderRequest flow. The driver mobile reads `kind` on
    // tap to decide which screen to deep-link to.
    const isRequest = event.source === 'order_request';
    const payload = {
      notification: {
        title: isRequest ? 'New delivery request' : 'New delivery available',
        body: `${priceText} · ${truncateAddress(event.pickupAddress)} → ${truncateAddress(event.deliveryAddress)}`,
      },
      data: {
        kind: isRequest ? 'order_request.created' : 'order.created',
        orderId: event.orderId,
        packageSize: event.packageSize,
        platformChargeNaira: String(event.platformChargeNaira),
      },
    };
    for (const driver of nearby) {
      void this.fanout.send(driver.userId, payload);
    }
  }

  // ────────────────────────────────── Phase 3 payment-confirmation
  @OnEvent('order.customer_marked_paid')
  onCustomerMarkedPaid(event: OrderCustomerMarkedPaidEvent): void {
    const amount = `₦${Number(event.amountNaira).toLocaleString('en-NG', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
    // Phase 3 — when the customer attached a screenshot, surface it
    // in the title so the driver knows the claim is backed by a
    // visual receipt before opening the app. Both bodies funnel into
    // the same "check + Confirm receipt" instruction.
    const title = event.hasProof
      ? 'Customer paid — screenshot attached'
      : 'Customer says they’ve paid';
    const proofSuffix = event.hasProof
      ? ' Compare with the attached screenshot before confirming.'
      : '';
    void this.fanout.send(event.driverId, {
      notification: {
        title,
        body: `${event.customerName} marked ${amount} as sent. Check your bank app, then tap Confirm receipt in the app.${proofSuffix}`,
      },
      data: {
        kind: 'order.customer_marked_paid',
        orderId: event.orderId,
        amountNaira: String(event.amountNaira),
        hasProof: event.hasProof ? 'true' : 'false',
      },
    });
  }

  @OnEvent('order.payment_confirmed')
  onPaymentConfirmed(event: OrderPaymentConfirmedEvent): void {
    const amount = `₦${Number(event.amountNaira).toLocaleString('en-NG', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
    void this.fanout.send(event.customerId, {
      notification: {
        title: 'Payment confirmed',
        body: `Your driver confirmed receipt of ${amount}. Thank you for using Orbit.`,
      },
      data: {
        kind: 'order.payment_confirmed',
        orderId: event.orderId,
        amountNaira: String(event.amountNaira),
      },
    });
  }

  // ────────────────────────────────── Wallet funding events
  @OnEvent('wallet.funded')
  onWalletFunded(event: WalletFundedEvent): void {
    const amount = `₦${Number(event.amountNaira).toLocaleString('en-NG', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
    void this.fanout.send(event.userId, {
      notification: {
        title: 'Wallet funded',
        body: `${amount} has been added to your wallet.`,
      },
      data: {
        kind: 'wallet.funded',
        reference: event.reference,
        amountNaira: String(event.amountNaira),
      },
    });
  }

  // ────────────────────────────────── I6 SOS events
  @OnEvent('incident.raised')
  async onIncidentRaised(event: IncidentRaisedEvent): Promise<void> {
    const admins = await this.users.find({
      where: { role: UserRole.ADMIN, isActive: true },
      select: ['id'],
    });
    if (admins.length === 0) {
      this.logger.warn(
        `incident.raised ${event.incidentId} but no active admins to notify.`,
      );
      return;
    }
    // PushPayload.data is `Record<string, string>` — coerce numerics +
    // omit null lat/lng so they don't leak in as the literal "null".
    const data: Record<string, string> = {
      kind: 'incident.raised',
      incidentId: event.incidentId,
      orderId: event.orderId,
      driverId: event.driverId,
    };
    if (event.latitude !== null && event.latitude !== undefined) {
      data.latitude = String(event.latitude);
    }
    if (event.longitude !== null && event.longitude !== undefined) {
      data.longitude = String(event.longitude);
    }
    const payload = {
      notification: {
        title: 'SOS — driver needs help',
        body: `Driver ${event.driverId.slice(0, 8)} raised an SOS on order ${event.orderId.slice(0, 8)}. Open the admin console to acknowledge.`,
      },
      data,
    };
    for (const admin of admins) {
      void this.fanout.send(admin.id, payload);
    }
  }

  @OnEvent('incident.acknowledged')
  onIncidentAcknowledged(event: IncidentAcknowledgedEvent): void {
    void this.fanout.send(event.driverId, {
      notification: {
        title: 'We see you',
        body: 'Support is on the way. An admin has acknowledged your SOS.',
      },
      data: {
        kind: 'incident.acknowledged',
        incidentId: event.incidentId,
        orderId: event.orderId,
        timeToAcknowledgeMs: String(event.timeToAcknowledgeMs),
      },
    });
  }

  /**
   * Resolve a polymorphic owner to the user_id we'd push to. For
   * `user` this is direct. For `vehicle` / `company`, D2 / D3 / D4
   * will wire richer lookups (assigned driver, company members). Until
   * then, the subscriber logs and skips — the doc.expired state
   * transition still ran; the user just gets the in-app banner via D5
   * the next time they open the app.
   */
  private resolveUserId(
    ownerType: DocumentOwnerType,
    ownerId: string,
  ): string | null {
    if (ownerType === DocumentOwnerType.USER) return ownerId;
    this.logger.debug(
      `Push fanout skipped for ownerType=${ownerType} ownerId=${ownerId} — vehicle/company resolution pending D2/D3/D4.`,
    );
    return null;
  }

  /**
   * Per-gate driver-pool diagnostic. Called when the main
   * eligibility query returns 0 rows so the warning log can name
   * the bottleneck gate instead of leaving ops to guess.
   *
   * Each count is a single COUNT(*) query; they're not exhaustive
   * (a driver could be "online but not active") but the relative
   * numbers immediately reveal which condition is the obstacle:
   *
   *   total=10 online=10 approvedOrActive=2 → 8 drivers are
   *     online but stuck pre-active. Approve them or unstick the
   *     approved→active transition.
   *
   *   total=10 online=0  → all drivers are offline.
   *
   *   ...withGps=0  → drivers toggle online without sending GPS;
   *     the mobile online-status call isn't including location.
   */
  private async diagnoseEligibilityFailure(charge: number): Promise<{
    total: number;
    online: number;
    approvedOrActive: number;
    notOnDelivery: number;
    withGps: number;
    funded: number;
  }> {
    const drivers = this.driverProfiles.createQueryBuilder('dp');
    const totalCount = await drivers.getCount();
    const onlineCount = await drivers
      .clone()
      .where('dp."isOnline" = true')
      .getCount();
    const approvedOrActiveCount = await drivers
      .clone()
      .where('dp."verificationStatus" IN (:...statuses)', {
        statuses: [
          DriverVerificationStatus.APPROVED,
          DriverVerificationStatus.ACTIVE,
        ],
      })
      .getCount();
    const notOnDeliveryCount = await drivers
      .clone()
      .where('dp."isOnDelivery" = false')
      .getCount();
    const withGpsCount = await drivers
      .clone()
      .where('dp."currentLatitude" IS NOT NULL')
      .andWhere('dp."currentLongitude" IS NOT NULL')
      .getCount();
    const fundedCount = await this.driverProfiles
      .createQueryBuilder('dp')
      .innerJoin(Wallet, 'w', 'w."userId" = dp."userId"')
      .innerJoin(
        '"wallet_balances"',
        'wb',
        'wb."wallet_id" = w."id"',
      )
      .where('wb."balance" >= :charge', { charge })
      .getCount();

    return {
      total: totalCount,
      online: onlineCount,
      approvedOrActive: approvedOrActiveCount,
      notOnDelivery: notOnDeliveryCount,
      withGps: withGpsCount,
      funded: fundedCount,
    };
  }
}

function humanizeDocType(type: string): string {
  switch (type) {
    case 'drivers_license':
      return "driver's license";
    case 'insurance':
      return 'insurance';
    case 'roadworthy':
      return 'roadworthy certificate';
    case 'lasaa_permit':
      return 'LASAA permit';
    case 'nipost_license':
      return 'NIPOST license';
    case 'vehicle_registration':
      return 'vehicle registration';
    default:
      return type.replace(/_/g, ' ');
  }
}

function truncateAddress(address: string): string {
  if (!address) return '';
  // FCM body has a 240-char practical limit; keep each leg short so
  // both pickup + dropoff fit alongside the price prefix.
  return address.length > 32 ? `${address.slice(0, 30)}…` : address;
}
