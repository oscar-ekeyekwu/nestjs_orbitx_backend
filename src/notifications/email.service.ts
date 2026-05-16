import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { SentMessageInfo, Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: Transporter<SentMessageInfo>;
  private fromEmail: string;

  constructor(private configService: ConfigService) {
    this.fromEmail = this.configService.get<string>(
      'EMAIL_FROM',
      'noreply@dispatch.com',
    );

    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('EMAIL_HOST', 'smtp.gmail.com'),
      port: this.configService.get<number>('EMAIL_PORT', 587),
      secure: false,
      auth: {
        user: this.configService.get<string>('EMAIL_USER'),
        pass: this.configService.get<string>('EMAIL_PASSWORD'),
      },
    }) as Transporter<SentMessageInfo>;
  }

  async sendEmail(
    to: string | undefined,
    subject: string | undefined,
    html: string | undefined,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const info = (await this.transporter.sendMail({
        from: this.fromEmail,
        to,
        subject,
        html,
      })) as { messageId?: string };

      return { success: true, messageId: info.messageId };
    } catch (err: unknown) {
      // Normalize unknown error to a string safely
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : (() => {
                try {
                  return JSON.stringify(err);
                } catch {
                  return 'Unknown email error';
                }
              })();

      // Log full error for diagnostics (stack if available)
      if (err instanceof Error) {
        console.error('Email error:', err.stack ?? err.message);
      } else {
        console.error('Email error:', err);
      }

      return { success: false, error: errorMessage };
    }
  }
}
