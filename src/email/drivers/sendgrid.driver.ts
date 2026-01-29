import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import { IEmailDriver, EmailOptions } from '../interfaces/email-driver.interface';

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
      const from = options.from || this.configService.get<string>('EMAIL_FROM', 'noreply@orbitx.com');

      const msg: any = {
        to: options.to,
        from,
        subject: options.subject,
      };

      // Add optional fields only if they exist
      if (options.text) msg.text = options.text;
      if (options.html) msg.html = options.html;
      if (options.attachments) msg.attachments = options.attachments;

      await sgMail.send(msg);
      this.logger.log(`Email sent successfully to ${options.to}`);
    } catch (error) {
      this.logger.error(`Failed to send email via SendGrid: ${error.message}`, error.stack);
      throw error;
    }
  }
}
