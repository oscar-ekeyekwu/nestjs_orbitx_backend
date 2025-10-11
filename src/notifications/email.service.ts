import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { SentMessageInfo, Transporter } from 'nodemailer';

interface OrderDetailsInterface {
  id: string;
  pickupAddress: string;
  deliveryAddress: string;
  estimatedPrice: number;
}

interface DriverDetailsInterface {
  id: string;
  name: string;
  phone: string;
}

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
      const info = await this.transporter.sendMail({
        from: this.fromEmail,
        to,
        subject,
        html,
      });

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

  async sendOrderCreatedEmail(to: string, orderDetails: OrderDetailsInterface) {
    const subject = 'Order Created Successfully';
    const html = `
      <h2>Your order has been created!</h2>
      <p>Order ID: <strong>${orderDetails.id}</strong></p>
      <p>Pickup: ${orderDetails.pickupAddress}</p>
      <p>Delivery: ${orderDetails.deliveryAddress}</p>
      <p>Estimated Price: ₦${orderDetails.estimatedPrice}</p>
      <p>Thank you for using our service!</p>
    `;

    return this.sendEmail(to, subject, html);
  }

  async sendOrderAcceptedEmail(
    to: string,
    orderDetails: OrderDetailsInterface,
    driverDetails: DriverDetailsInterface,
  ) {
    const subject = 'Driver Assigned to Your Order';
    const html = `
      <h2>A driver has been assigned!</h2>
      <p>Order ID: <strong>${orderDetails.id}</strong></p>
      <p>Driver: ${driverDetails.name}</p>
      <p>Phone: ${driverDetails.phone}</p>
      <p>Your package will be picked up soon.</p>
    `;

    return this.sendEmail(to, subject, html);
  }

  async sendOrderDeliveredEmail(
    to: string,
    orderDetails: OrderDetailsInterface,
  ) {
    const subject = 'Order Delivered Successfully';
    const html = `
      <h2>Your order has been delivered!</h2>
      <p>Order ID: <strong>${orderDetails.id}</strong></p>
      <p>Delivery Address: ${orderDetails.deliveryAddress}</p>
      <p>Thank you for choosing our service!</p>
    `;

    return this.sendEmail(to, subject, html);
  }
}
