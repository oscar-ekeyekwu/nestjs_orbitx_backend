import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

interface NotificationData {
  [key: string]: string;
}

interface NotificationResult {
  success: boolean;
  messageId?: string;
  successCount?: number;
  failureCount?: number;
  error?: string;
}

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(private readonly configService: ConfigService) {
    // Initialize Firebase Admin only once
    if (!admin.apps.length) {
      const serviceAccount = this.configService.get<string>(
        'FIREBASE_SERVICE_ACCOUNT',
      );

      if (serviceAccount) {
        try {
          const parsedAccount = JSON.parse(serviceAccount);

          admin.initializeApp({
            credential: admin.credential.cert(parsedAccount),
          });

          this.logger.log('✅ Firebase Admin initialized successfully.');
        } catch (err) {
          this.logger.error(
            '❌ Invalid FIREBASE_SERVICE_ACCOUNT JSON format.',
            err,
          );
        }
      } else {
        this.logger.warn(
          '⚠️ FIREBASE_SERVICE_ACCOUNT not configured. Push notifications disabled.',
        );
      }
    }
  }

  /**
   * Send a push notification to a single device
   */
  async sendToDevice(
    fcmToken: string,
    title: string,
    body: string,
    data?: NotificationData,
  ): Promise<NotificationResult> {
    try {
      const message: admin.messaging.Message = {
        notification: { title, body },
        data: data || {},
        token: fcmToken,
      };

      const response = await admin.messaging().send(message);
      this.logger.log(`📲 Push notification sent to device: ${fcmToken}`);
      return { success: true, messageId: response };
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.error(`❌ Push notification error: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Send a push notification to multiple devices
   */
  async sendToMultipleDevices(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: NotificationData,
  ): Promise<NotificationResult> {
    if (!Array.isArray(fcmTokens) || fcmTokens.length === 0) {
      this.logger.warn('⚠️ No FCM tokens provided for multicast push.');
      return {
        success: false,
        error: 'No FCM tokens provided.',
      };
    }

    try {
      const message: admin.messaging.MulticastMessage = {
        notification: {
          title,
          body,
        },
        data: data ?? {},
        tokens: fcmTokens,
      };

      const messaging = admin.messaging() as unknown as {
        sendMulticast: (
          message: admin.messaging.MulticastMessage,
        ) => Promise<admin.messaging.BatchResponse>;
      };

      const response = await messaging.sendMulticast(message);

      this.logger.log(
        `📡 Multicast push sent: ${response.successCount} succeeded, ${response.failureCount} failed.`,
      );

      return {
        success: true,
        successCount: response.successCount,
        failureCount: response.failureCount,
      };
    } catch (error: unknown) {
      let errorMessage = 'Unknown error';

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error
      ) {
        errorMessage = String((error as { message?: string }).message);
      } else {
        errorMessage = JSON.stringify(error);
      }

      this.logger.error(`❌ Batch push notification error: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Send a push notification to a topic
   */
  async sendToTopic(
    topic: string,
    title: string,
    body: string,
    data?: NotificationData,
  ): Promise<NotificationResult> {
    try {
      const message: admin.messaging.Message = {
        notification: { title, body },
        data: data || {},
        topic,
      };

      const response = await admin.messaging().send(message);
      this.logger.log(`📢 Push notification sent to topic: ${topic}`);
      return { success: true, messageId: response };
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.error(`❌ Topic notification error: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }
}
