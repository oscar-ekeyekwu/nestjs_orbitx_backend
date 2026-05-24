/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import { Repository } from 'typeorm';
import {
  ExpoPushLike,
  FirebaseMessagingLike,
  PushFanoutService,
  type PushPayload,
} from './push-fanout.service';
import { DeviceToken, DevicePlatform } from './entities/device-token.entity';

function buildToken(overrides: Partial<DeviceToken>): DeviceToken {
  return {
    id: `dt-${Math.random().toString(36).slice(2)}`,
    userId: 'user-1',
    user: undefined as unknown as DeviceToken['user'],
    token: 'fcm-token-default',
    platform: DevicePlatform.ANDROID,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DeviceToken;
}

const PAYLOAD: PushPayload = {
  notification: { title: 'Test', body: 'Body' },
  data: { kind: 'unit-test' },
};

describe('PushFanoutService (ARCH-10)', () => {
  let repo: jest.Mocked<Repository<DeviceToken>>;
  let messaging: jest.Mocked<FirebaseMessagingLike>;
  let service: PushFanoutService;

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    } as unknown as jest.Mocked<Repository<DeviceToken>>;

    messaging = {
      sendEachForMulticast: jest.fn(),
    } as unknown as jest.Mocked<FirebaseMessagingLike>;

    service = new PushFanoutService(repo, messaging);
  });

  it('returns silently when the user has zero active tokens', async () => {
    repo.find.mockResolvedValue([]);

    await expect(service.send('user-1', PAYLOAD)).resolves.toBeUndefined();
    expect(messaging.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('multi-token: invokes sendEachForMulticast with every active token', async () => {
    repo.find.mockResolvedValue([
      buildToken({ id: 't-1', token: 'fcm-a' }),
      buildToken({ id: 't-2', token: 'fcm-b' }),
    ]);
    messaging.sendEachForMulticast.mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [{ success: true }, { success: true }],
    } as never);

    await service.send('user-1', PAYLOAD);

    expect(messaging.sendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['fcm-a', 'fcm-b'],
        notification: PAYLOAD.notification,
        data: PAYLOAD.data,
      }),
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('UNREGISTERED response deactivates the stale token only', async () => {
    repo.find.mockResolvedValue([
      buildToken({ id: 't-good', token: 'fcm-good' }),
      buildToken({ id: 't-stale', token: 'fcm-stale' }),
    ]);
    messaging.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
      ],
    } as never);

    await service.send('user-1', PAYLOAD);

    expect(repo.update).toHaveBeenCalledWith(['t-stale'], { isActive: false });
  });

  it('non-UNREGISTERED failure (transient) does NOT deactivate', async () => {
    repo.find.mockResolvedValue([buildToken({ id: 't-1', token: 'fcm-1' })]);
    messaging.sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        {
          success: false,
          error: { code: 'messaging/internal-error' },
        },
      ],
    } as never);

    await service.send('user-1', PAYLOAD);

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('Firebase throws → swallows, never propagates', async () => {
    repo.find.mockResolvedValue([buildToken({})]);
    messaging.sendEachForMulticast.mockRejectedValue(
      new Error('firebase down'),
    );

    await expect(service.send('user-1', PAYLOAD)).resolves.toBeUndefined();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('logs a warning when Firebase takes >200ms', async () => {
    repo.find.mockResolvedValue([buildToken({})]);
    messaging.sendEachForMulticast.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                successCount: 1,
                failureCount: 0,
                responses: [{ success: true }],
              } as never),
            250,
          ),
        ),
    );

    // Spy on the logger that the service constructs internally.
    const internalLogger = (
      service as unknown as { logger: { warn: (msg: string) => void } }
    ).logger;
    const loggerWarnSpy = jest.spyOn(internalLogger, 'warn');

    await service.send('user-1', PAYLOAD);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/slow|NFR-P1/),
    );
  }, 5000);

  it('fanout skipped (logged) when no messaging adapter is wired', async () => {
    const noMessagingService = new PushFanoutService(repo, undefined);
    repo.find.mockResolvedValue([buildToken({})]);

    await expect(
      noMessagingService.send('user-1', PAYLOAD),
    ).resolves.toBeUndefined();
    // Should not have tried to call any messaging method.
    expect(messaging.sendEachForMulticast).not.toHaveBeenCalled();
  });

  describe('Expo push path (J5)', () => {
    let expoMock: jest.Mocked<ExpoPushLike>;
    let dualService: PushFanoutService;

    beforeEach(() => {
      expoMock = {
        chunkPushNotifications: jest.fn((msgs) => [msgs]),
        sendPushNotificationsAsync: jest.fn(),
      } as unknown as jest.Mocked<ExpoPushLike>;
      dualService = new PushFanoutService(repo, messaging, expoMock);
    });

    it('routes ExponentPushToken[...] tokens through the Expo SDK, not FCM', async () => {
      repo.find.mockResolvedValue([
        buildToken({ id: 't-expo', token: 'ExponentPushToken[abc123]' }),
      ]);
      expoMock.sendPushNotificationsAsync.mockResolvedValue([
        { status: 'ok', id: 'ticket-1' } as never,
      ]);

      await dualService.send('user-1', PAYLOAD);

      expect(expoMock.sendPushNotificationsAsync).toHaveBeenCalledWith([
        expect.objectContaining({
          to: 'ExponentPushToken[abc123]',
          title: PAYLOAD.notification.title,
          body: PAYLOAD.notification.body,
          data: PAYLOAD.data,
        }),
      ]);
      expect(messaging.sendEachForMulticast).not.toHaveBeenCalled();
    });

    it('partitions: ExponentPushToken via Expo, raw token via FCM, in parallel', async () => {
      repo.find.mockResolvedValue([
        buildToken({ id: 't-expo', token: 'ExponentPushToken[xyz]' }),
        buildToken({ id: 't-fcm', token: 'raw-fcm-token' }),
      ]);
      expoMock.sendPushNotificationsAsync.mockResolvedValue([
        { status: 'ok', id: 'ticket-1' } as never,
      ]);
      messaging.sendEachForMulticast.mockResolvedValue({
        successCount: 1,
        failureCount: 0,
        responses: [{ success: true }],
      } as never);

      await dualService.send('user-1', PAYLOAD);

      expect(expoMock.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
      expect(messaging.sendEachForMulticast).toHaveBeenCalledWith(
        expect.objectContaining({ tokens: ['raw-fcm-token'] }),
      );
    });

    it('DeviceNotRegistered Expo ticket deactivates that token only', async () => {
      repo.find.mockResolvedValue([
        buildToken({ id: 't-good', token: 'ExponentPushToken[ok]' }),
        buildToken({ id: 't-dead', token: 'ExponentPushToken[stale]' }),
      ]);
      expoMock.sendPushNotificationsAsync.mockResolvedValue([
        { status: 'ok', id: 'tic-1' } as never,
        {
          status: 'error',
          message: 'unregistered',
          details: { error: 'DeviceNotRegistered' },
        } as never,
      ]);

      await dualService.send('user-1', PAYLOAD);

      expect(repo.update).toHaveBeenCalledWith(['t-dead'], { isActive: false });
    });

    it('Expo SDK throws → swallows, never propagates', async () => {
      repo.find.mockResolvedValue([
        buildToken({ id: 't-1', token: 'ExponentPushToken[abc]' }),
      ]);
      expoMock.sendPushNotificationsAsync.mockRejectedValue(
        new Error('expo down'),
      );

      await expect(
        dualService.send('user-1', PAYLOAD),
      ).resolves.toBeUndefined();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});
