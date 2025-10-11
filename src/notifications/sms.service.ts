import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

interface SmsResult {
  success: boolean;
  messageId?: string;
  message?: string;
  error?: string;
}

@Injectable()
export class SmsService {
  private readonly twilioClient?: Twilio;
  private readonly fromNumber?: string;
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly configService: ConfigService) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER');

    if (accountSid && authToken) {
      this.twilioClient = new Twilio(accountSid, authToken);
      this.logger.log('✅ Twilio client initialized successfully');
    } else {
      this.logger.warn(
        '⚠️ Twilio credentials not found. SMS will be simulated (not sent).',
      );
    }
  }

  /**
   * Sends a single SMS message
   */
  async sendSms(to: string, message: string): Promise<SmsResult> {
    try {
      if (!this.twilioClient) {
        this.logger.debug(`Simulated SMS to ${to}: "${message}"`);
        return {
          success: true,
          message: 'SMS simulated (Twilio not configured)',
        };
      }

      const result = await this.twilioClient.messages.create({
        body: message,
        from: this.fromNumber,
        to,
      });

      this.logger.log(`📩 SMS sent successfully to ${to}, SID: ${result.sid}`);
      return { success: true, messageId: result.sid };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error);

      this.logger.error(`❌ SMS sending failed to ${to}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Sends an SMS message to multiple phone numbers concurrently
   */
  async sendBulkSms(
    phoneNumbers: string[],
    message: string,
  ): Promise<{ successCount: number; failureCount: number }> {
    const results = await Promise.all(
      phoneNumbers.map(async (phone) => {
        const response = await this.sendSms(phone, message);
        return response.success;
      }),
    );

    const successCount = results.filter((success) => success).length;
    const failureCount = results.length - successCount;

    this.logger.log(
      `📤 Bulk SMS summary: ${successCount} succeeded, ${failureCount} failed.`,
    );

    return { successCount, failureCount };
  }
}
