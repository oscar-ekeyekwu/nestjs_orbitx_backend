import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { StorageRegistry } from '../storage/storage-registry.service';
import { EmailService } from '../notifications/email.service';
import { SmsService } from '../notifications/sms.service';
import { renderReceipt, type ReceiptInput } from './receipt-renderer';
import { maskEmail, maskPhone } from './pii-mask';

const RECEIPT_VIEW_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (E4 AC).
const RECEIPT_CONTENT_TYPE = 'application/pdf';

export interface DispatchResult {
  channel: 'email' | 'sms' | 'none';
  receiptUrl: string;
  objectKey: string;
}

/**
 * E4 — generate + persist + dispatch a PDF receipt when an order
 * completes.
 *
 * Lifecycle:
 *   1. updateStatus(...) flips the order to DELIVERED.
 *   2. OrdersService calls `generateForOrder(orderId)` (best-effort —
 *      a receipt failure must not roll back the delivery transaction).
 *   3. This service hydrates the order, renders a PDF, uploads it to
 *      `receipts/<orderId>.pdf` in the private bucket, mints a 7-day
 *      presigned URL, and hands it to the email or SMS dispatcher
 *      based on which contact the customer has on file.
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
    private readonly storage: StorageRegistry,
    // forwardRef on the provider injections to mirror the module-level
    // forwardRef on NotificationsModule (see receipts.module.ts comment).
    @Inject(forwardRef(() => EmailService))
    private readonly email: EmailService,
    @Inject(forwardRef(() => SmsService))
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {}

  async generateForOrder(orderId: string): Promise<DispatchResult> {
    const order = await this.ordersRepo.findOne({
      where: { id: orderId },
      relations: ['customer'],
    });
    if (!order) {
      throw new Error(`Order ${orderId} not found for receipt generation`);
    }

    const input = this.buildReceiptInput(order);
    const pdf = await renderReceipt(input);
    const objectKey = `receipts/${order.id}.pdf`;
    // E4 receipts land in the currently active provider's bucket under
    // the `receipts/` prefix. They are not first-class `Document` rows,
    // so they don't get tracked in the migration table — STG-4 migrates
    // KYC docs only. A future story can extend that if receipts need
    // to follow the same bucket.
    const adapter = await this.storage.getActive();
    await adapter.uploadBuffer(objectKey, pdf, RECEIPT_CONTENT_TYPE);

    const receiptUrl = await adapter.generateViewUrl(
      objectKey,
      RECEIPT_VIEW_URL_TTL_SECONDS,
    );

    const channel = await this.dispatch(order, input, receiptUrl);
    return { channel, receiptUrl, objectKey };
  }

  private buildReceiptInput(order: Order): ReceiptInput {
    // Naira values are branded Decimal-backed; coerce to a plain number
    // for the renderer (which prints a localized string, not arithmetic).
    const price = order.finalPrice ?? order.estimatedPrice;
    const totalNaira = price ? Number(price.toString()) : 0;

    const completedAt = order.deliveredAt ?? order.updatedAt ?? new Date();

    return {
      orderShortId: order.id.slice(-8),
      customerName: order.customer?.name?.trim() || 'Customer',
      customerEmail: order.customer?.email ?? null,
      customerPhone: order.customer?.phone ?? null,
      pickupAddress: order.pickupAddress ?? '',
      deliveryAddress: order.deliveryAddress ?? '',
      packageSize: order.packageSize ?? null,
      totalNaira,
      // G1-G3 (Sprint 5) fill these in; until then we render an
      // honest placeholder rather than a misleading default.
      paymentMethod: 'Pending (Sprint 5)',
      transactionRef: null,
      completedAtIso: new Date(completedAt).toISOString(),
      nipostLicense: this.config.get<string>('OPERATOR_NIPOST_LICENSE') ?? null,
    };
  }

  private async dispatch(
    order: Order,
    input: ReceiptInput,
    receiptUrl: string,
  ): Promise<DispatchResult['channel']> {
    const subject = `Your Orbit receipt for order #${input.orderShortId}`;
    const html = this.renderEmailBody(input, receiptUrl);
    const smsCopy = `Orbit: receipt for order #${input.orderShortId} (₦${formatAmount(
      input.totalNaira,
    )}). Download: ${receiptUrl}`;

    // Email preferred; SMS as fallback. We log the masked target so the
    // log stream can't be mined for full phone / email values.
    if (input.customerEmail) {
      try {
        await this.email.sendEmail(input.customerEmail, subject, html);
        this.logger.log(
          `Receipt emailed for order ${order.id} to ${maskEmail(
            input.customerEmail,
          )}`,
        );
        return 'email';
      } catch (err) {
        this.logger.warn(
          `Receipt email dispatch failed for order ${order.id}: ${err}`,
        );
        // Fall through to SMS rather than giving up.
      }
    }

    if (input.customerPhone) {
      try {
        await this.sms.sendSms(input.customerPhone, smsCopy);
        this.logger.log(
          `Receipt SMSed for order ${order.id} to ${maskPhone(
            input.customerPhone,
          )}`,
        );
        return 'sms';
      } catch (err) {
        this.logger.warn(
          `Receipt SMS dispatch failed for order ${order.id}: ${err}`,
        );
      }
    }

    this.logger.warn(
      `Receipt for order ${order.id} not dispatched — no email or phone on file`,
    );
    return 'none';
  }

  private renderEmailBody(input: ReceiptInput, receiptUrl: string): string {
    return `
      <p>Hi ${escapeHtml(input.customerName.split(' ')[0] || 'there')},</p>
      <p>Thank you for using Orbit. Your delivery for order
      <strong>#${escapeHtml(input.orderShortId)}</strong> is complete.</p>
      <p>Total: <strong>₦${escapeHtml(formatAmount(input.totalNaira))}</strong></p>
      <p>You can download your receipt here (link valid for 7 days):</p>
      <p><a href="${escapeHtml(receiptUrl)}">Download receipt (PDF)</a></p>
      <p>— Orbit</p>
    `.trim();
  }
}

function formatAmount(amount: number): string {
  return Math.round(amount).toLocaleString('en-NG');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
