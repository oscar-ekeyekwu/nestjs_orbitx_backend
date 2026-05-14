import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import type { MailDataRequired } from '@sendgrid/mail';
import {
  IEmailDriver,
  EmailOptions,
} from '../interfaces/email-driver.interface';

@Injectable()
export class SendGridDriver implements IEmailDriver {
  private readonly logger = new Logger(SendGridDriver.name);

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    if (apiKey) {
      sgMail.setApiKey(apiKey);
      this.logger.log('SendGrid driver initialized');
    } else {
      this.logger.warn('SendGrid API key not found');
    }
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    try {
      const from =
        options.from ??
        this.configService.get<string>('EMAIL_FROM', 'noreply@orbitx.com');

      const msg = {
        to: options.to,
        from,
        subject: options.subject,
        ...(options.text ? { text: options.text } : {}),
        ...(options.html ? { html: options.html } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
      } as MailDataRequired;

      await sgMail.send(msg);
      const recipient = Array.isArray(options.to)
        ? options.to.join(', ')
        : options.to;
      this.logger.log(`Email sent successfully to ${recipient}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to send email via SendGrid: ${message}`, stack);
      throw error;
    }
  }
}
