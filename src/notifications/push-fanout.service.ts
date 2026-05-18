import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as admin from 'firebase-admin';
import { DeviceToken } from './entities/device-token.entity';

export interface PushPayload {
  notification: {
    title: string;
    body: string;
  };
  data?: Record<string, string>;
}

export interface FirebaseMessagingLike {
  sendEachForMulticast(
    message: admin.messaging.MulticastMessage,
  ): Promise<admin.messaging.BatchResponse>;
}

/**
 * DI token for the Firebase messaging adapter. Production wires
 * `admin.messaging()`; unit tests inject a tiny stub. Keeping the
 * indirection means the service can be tested without booting a real
 * Firebase app or globally mocking the SDK.
 */
export const FIREBASE_MESSAGING = Symbol('FIREBASE_MESSAGING');

/**
 * ARCH-10 — per-user push fanout.
 *
 * Public surface is a single `send(userId, payload)`. Behaviour:
 *
 *   1. Lookup active device_tokens for the user.
 *   2. If zero → return silently (most server-driven flows hit users
 *      who never installed the app).
 *   3. sendEachForMulticast on the live tokens.
 *   4. Any UNREGISTERED responses → flip isActive=false on that row
 *      so the next sweep doesn't re-attempt a dead handset.
 *   5. If Firebase takes >200 ms, log a warning and continue — never
 *      block the caller's request handler beyond the NFR-P1 budget.
 *
 * Callers (event subscribers, controllers, services) MUST NOT await
 * this method on a hot request path if they care about latency.
 * Fire-and-forget via `void` is the documented pattern; the service
 * swallows internal errors so a bad Firebase response can't 500 an
 * unrelated handler.
 */
@Injectable()
export class PushFanoutService {
  private readonly logger = new Logger(PushFanoutService.name);
  private static readonly SLOW_THRESHOLD_MS = 200;
  private static readonly UNREGISTERED_CODE =
    'messaging/registration-token-not-registered';

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepo: Repository<DeviceToken>,
    @Optional()
    @Inject(FIREBASE_MESSAGING)
    private readonly messaging?: FirebaseMessagingLike,
  ) {}

  async send(userId: string, payload: PushPayload): Promise<void> {
    const tokens = await this.deviceTokenRepo.find({
      where: { userId, isActive: true },
    });
    if (tokens.length === 0) return;

    const messaging = this.resolveMessaging();
    if (!messaging) {
      this.logger.warn(
        `Push fanout skipped — Firebase messaging not initialized; would have sent to user=${userId} tokens=${tokens.length}.`,
      );
      return;
    }

    const start = Date.now();
    let response: admin.messaging.BatchResponse;
    try {
      response = await messaging.sendEachForMulticast({
        tokens: tokens.map((t) => t.token),
        notification: payload.notification,
        data: payload.data,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Push fanout failed for user=${userId}: ${message}. Continuing.`,
      );
      return;
    }
    const elapsed = Date.now() - start;
    if (elapsed > PushFanoutService.SLOW_THRESHOLD_MS) {
      this.logger.warn(
        `Push fanout slow: ${elapsed}ms for ${tokens.length} tokens (user=${userId}). NFR-P1 budget exceeded.`,
      );
    }

    await this.cleanupStaleTokens(tokens, response);
  }

  private resolveMessaging(): FirebaseMessagingLike | null {
    if (this.messaging) return this.messaging;
    // Production path — the existing PushNotificationService boots
    // firebase-admin at module construction, so by the time the
    // first event fires admin.apps.length > 0. If it isn't, return
    // null so we degrade gracefully instead of throwing.
    if (admin.apps.length === 0) return null;
    return admin.messaging() as unknown as FirebaseMessagingLike;
  }

  private async cleanupStaleTokens(
    tokens: DeviceToken[],
    response: admin.messaging.BatchResponse,
  ): Promise<void> {
    const staleIds: string[] = [];
    response.responses.forEach((res, i) => {
      if (res.success) return;
      const code = res.error?.code;
      if (code === PushFanoutService.UNREGISTERED_CODE) {
        staleIds.push(tokens[i].id);
      }
    });
    if (staleIds.length === 0) return;
    await this.deviceTokenRepo.update(staleIds, { isActive: false });
    this.logger.log(
      `Push fanout cleanup: deactivated ${staleIds.length} unregistered token(s).`,
    );
  }
}
