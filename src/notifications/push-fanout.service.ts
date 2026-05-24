import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as admin from 'firebase-admin';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { DeviceToken } from './entities/device-token.entity';

// Inline matcher so tests don't need to import the ESM-only
// expo-server-sdk runtime — the SDK is lazy-loaded inside resolveExpo()
// and the partition path uses this regex directly. Matches both
// historical forms Expo has emitted (ExponentPushToken[...] is current,
// ExpoPushToken[...] was used briefly during the SDK 49 transition).
function isExpoPushToken(token: string): boolean {
  return (
    /^ExponentPushToken\[.+\]$/.test(token) ||
    /^ExpoPushToken\[.+\]$/.test(token)
  );
}

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
 * DI token for an Expo SDK instance. Production uses a real `new Expo()`;
 * unit tests inject a stub that returns canned ticket arrays. Symmetric
 * with FIREBASE_MESSAGING.
 */
export const EXPO_PUSH = Symbol('EXPO_PUSH');

export interface ExpoPushLike {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(
    messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]>;
}

/**
 * ARCH-10 — per-user push fanout. Dual-path:
 *
 *   - Tokens of the form `ExponentPushToken[...]` go through Expo's
 *     push service (https://exp.host/--/api/v2/push/send). This is the
 *     path the current OrbitMobile build uses; it asks the OS for an
 *     Expo push token via `Notifications.getExpoPushTokenAsync()` and
 *     POSTs it to /device-tokens.
 *   - Anything else is assumed to be a raw FCM/APNs token and routed
 *     through firebase-admin. Reserved for future native builds that
 *     ship `google-services.json` and call `getDevicePushTokenAsync()`.
 *
 * Callers (event subscribers, controllers, services) MUST NOT await
 * this method on a hot request path if they care about latency.
 * Fire-and-forget via `void` is the documented pattern; the service
 * swallows internal errors so a bad push response can't 500 an
 * unrelated handler. Stale-token cleanup (DeviceNotRegistered on the
 * Expo path, registration-token-not-registered on the FCM path) flips
 * `isActive=false` on the offending row.
 */
@Injectable()
export class PushFanoutService {
  private readonly logger = new Logger(PushFanoutService.name);
  private static readonly SLOW_THRESHOLD_MS = 200;
  private static readonly FCM_UNREGISTERED_CODE =
    'messaging/registration-token-not-registered';
  private static readonly EXPO_UNREGISTERED_CODE = 'DeviceNotRegistered';

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepo: Repository<DeviceToken>,
    @Optional()
    @Inject(FIREBASE_MESSAGING)
    private readonly messaging?: FirebaseMessagingLike,
    @Optional()
    @Inject(EXPO_PUSH)
    private readonly expoOverride?: ExpoPushLike,
  ) {}

  async send(userId: string, payload: PushPayload): Promise<void> {
    const tokens = await this.deviceTokenRepo.find({
      where: { userId, isActive: true },
    });
    if (tokens.length === 0) {
      this.logger.warn(
        `Push fanout skipped — user=${userId} has zero active device tokens. Title="${payload.notification.title}".`,
      );
      return;
    }

    const { expoTokens, fcmTokens } = this.partition(tokens);
    this.logger.log(
      `Push fanout → user=${userId} expo=${expoTokens.length} fcm=${fcmTokens.length} title="${payload.notification.title}".`,
    );

    const start = Date.now();
    await Promise.all([
      this.sendViaExpo(userId, expoTokens, payload),
      this.sendViaFcm(userId, fcmTokens, payload),
    ]);
    const elapsed = Date.now() - start;
    if (elapsed > PushFanoutService.SLOW_THRESHOLD_MS) {
      this.logger.warn(
        `Push fanout slow: ${elapsed}ms for ${tokens.length} tokens (user=${userId}). NFR-P1 budget exceeded.`,
      );
    }
  }

  private partition(tokens: DeviceToken[]): {
    expoTokens: DeviceToken[];
    fcmTokens: DeviceToken[];
  } {
    const expoTokens: DeviceToken[] = [];
    const fcmTokens: DeviceToken[] = [];
    for (const t of tokens) {
      if (isExpoPushToken(t.token)) expoTokens.push(t);
      else fcmTokens.push(t);
    }
    return { expoTokens, fcmTokens };
  }

  private async sendViaExpo(
    userId: string,
    tokens: DeviceToken[],
    payload: PushPayload,
  ): Promise<void> {
    if (tokens.length === 0) return;
    const expo = await this.resolveExpo();
    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      sound: 'default',
      title: payload.notification.title,
      body: payload.notification.body,
      data: payload.data,
      priority: 'high',
      channelId: 'orbit-default',
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of chunks) {
      try {
        const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...chunkTickets);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Expo push fanout chunk failed for user=${userId}: ${message}. Continuing.`,
        );
      }
    }
    await this.cleanupExpoStaleTokens(tokens, tickets);
  }

  private async sendViaFcm(
    userId: string,
    tokens: DeviceToken[],
    payload: PushPayload,
  ): Promise<void> {
    if (tokens.length === 0) return;
    const messaging = this.resolveMessaging();
    if (!messaging) {
      this.logger.warn(
        `FCM push skipped — Firebase messaging not initialized; would have sent to user=${userId} tokens=${tokens.length}.`,
      );
      return;
    }
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
        `FCM push fanout failed for user=${userId}: ${message}. Continuing.`,
      );
      return;
    }
    await this.cleanupFcmStaleTokens(tokens, response);
  }

  private resolveMessaging(): FirebaseMessagingLike | null {
    if (this.messaging) return this.messaging;
    if (admin.apps.length === 0) return null;
    return admin.messaging() as unknown as FirebaseMessagingLike;
  }

  // Cached after the first lazy import so concurrent sends share one
  // Expo client.
  private cachedExpo: ExpoPushLike | null = null;

  private async resolveExpo(): Promise<ExpoPushLike> {
    if (this.expoOverride) return this.expoOverride;
    if (this.cachedExpo) return this.cachedExpo;
    // ESM-only at v6+. Dynamic import lets us stay on commonjs while
    // still pulling the runtime SDK; Jest never executes this path
    // because tests pass an EXPO_PUSH override.
    const mod = (await import('expo-server-sdk')) as unknown as {
      Expo: new () => ExpoPushLike;
    };
    this.cachedExpo = new mod.Expo();
    return this.cachedExpo;
  }

  private async cleanupFcmStaleTokens(
    tokens: DeviceToken[],
    response: admin.messaging.BatchResponse,
  ): Promise<void> {
    const staleIds: string[] = [];
    response.responses.forEach((res, i) => {
      if (res.success) return;
      const code = res.error?.code;
      if (code === PushFanoutService.FCM_UNREGISTERED_CODE) {
        staleIds.push(tokens[i].id);
      }
    });
    if (staleIds.length === 0) return;
    await this.deviceTokenRepo.update(staleIds, { isActive: false });
    this.logger.log(
      `FCM cleanup: deactivated ${staleIds.length} unregistered token(s).`,
    );
  }

  private async cleanupExpoStaleTokens(
    tokens: DeviceToken[],
    tickets: ExpoPushTicket[],
  ): Promise<void> {
    if (tickets.length === 0) return;
    const staleIds: string[] = [];
    // Tickets are 1:1 with the messages array we built from `tokens`,
    // unless a chunk fully failed (then those slots are missing). Walk
    // tickets and match by index against `tokens`.
    tickets.forEach((ticket, i) => {
      if (ticket.status !== 'error') return;
      const detailsCode = ticket.details?.error;
      if (detailsCode === PushFanoutService.EXPO_UNREGISTERED_CODE) {
        const token = tokens[i];
        if (token) staleIds.push(token.id);
      } else {
        this.logger.warn(
          `Expo push error (kept active): ${ticket.message} code=${detailsCode ?? 'unknown'}.`,
        );
      }
    });
    if (staleIds.length === 0) return;
    await this.deviceTokenRepo.update(staleIds, { isActive: false });
    this.logger.log(
      `Expo cleanup: deactivated ${staleIds.length} DeviceNotRegistered token(s).`,
    );
  }
}
