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
