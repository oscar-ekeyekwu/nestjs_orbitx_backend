import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type {
  InitializePaymentInput,
  InitializePaymentResult,
  IPaymentGateway,
  VirtualAccountResult,
  WebhookEvent,
  WebhookEventMetadata,
} from '../interfaces/payment-gateway.interface';

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

interface PaystackCustomer {
  customer_code: string;
}

interface PaystackDedicatedAccount {
  account_number: string;
  account_name: string;
  bank?: { name?: string };
  bank_name?: string;
  id?: number | string;
}

interface PaystackChargeSuccessPayload {
  event: string;
  data: {
    amount: number;
    reference: string;
    metadata?: WebhookEventMetadata;
  };
}

interface PaystackInitializeResponse {
  access_code: string;
  reference: string;
  authorization_url: string;
}

@Injectable()
export class PaystackGateway implements IPaymentGateway {
  private readonly logger = new Logger(PaystackGateway.name);
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.secretKey =
      this.configService.get<string>('PAYSTACK_SECRET_KEY') || '';
    this.baseUrl =
      this.configService.get<string>('PAYSTACK_BASE_URL') ||
      'https://api.paystack.co';
  }

  async createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult> {
    // Step 1: Create customer
    const customerRes = await fetch(`${this.baseUrl}/customer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.email,
        first_name: params.name.split(' ')[0] || params.name,
        last_name: params.name.split(' ').slice(1).join(' ') || params.name,
        metadata: { userId: params.userId },
      }),
    });

    const customerData =
      (await customerRes.json()) as PaystackEnvelope<PaystackCustomer>;
    if (!customerData.status) {
      // Customer may already exist — try fetching
      this.logger.warn(`Paystack create customer: ${customerData.message}`);
    }

    const customerCode: string =
      customerData.data?.customer_code ??
      (await this.fetchCustomerCode(params.email));

    // Step 2: Assign dedicated virtual account
    const dvaRes = await fetch(`${this.baseUrl}/dedicated_account/assign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.email,
        first_name: params.name.split(' ')[0] || params.name,
        last_name: params.name.split(' ').slice(1).join(' ') || params.name,
        phone: '+2340000000000',
        preferred_bank: 'wema-bank',
        country: 'NG',
        customer: customerCode,
      }),
    });

    const dvaData =
      (await dvaRes.json()) as PaystackEnvelope<PaystackDedicatedAccount>;

    if (!dvaData.status || !dvaData.data) {
      throw new Error(
        `Failed to create virtual account: ${dvaData.message ?? 'Unknown error'}`,
      );
    }

    const account = dvaData.data;

    return {
      accountNumber: account.account_number,
      bankName: account.bank?.name ?? account.bank_name ?? 'Wema Bank',
      accountName: account.account_name,
      providerReference: account.id?.toString() ?? account.account_number,
      provider: 'paystack',
    };
  }

  private async fetchCustomerCode(email: string): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/customer/${encodeURIComponent(email)}`,
      {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      },
    );
    const data = (await res.json()) as PaystackEnvelope<PaystackCustomer>;
    if (!data.status || !data.data?.customer_code) {
      throw new Error('Could not retrieve Paystack customer code');
    }
    return data.data.customer_code;
  }

  /**
   * ARCH-13 — initialize a Paystack transaction for an order. The
   * caller (PaymentService) has already minted a pending Transaction
   * row whose id we pass as `reference`; Paystack echoes that
   * reference back on the webhook so the handler can find the row
   * without a metadata lookup.
   *
   * amount is sent in kobo (Paystack's smallest unit). All money
   * flowing across the API boundary is integer kobo; never floats.
   */
  async initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const amountKobo = Math.round(input.amountNaira * 100);
    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountKobo,
        email: input.email,
        reference: input.transactionId,
        metadata: {
          orderId: input.orderId,
          transactionId: input.transactionId,
        },
      }),
    });

    const envelope =
      (await res.json()) as PaystackEnvelope<PaystackInitializeResponse>;
    if (!envelope.status || !envelope.data) {
      throw new Error(
        `Paystack initialize failed: ${envelope.message ?? 'Unknown error'}`,
      );
    }
    return {
      accessCode: envelope.data.access_code,
      reference: envelope.data.reference,
      authorizationUrl: envelope.data.authorization_url,
    };
  }

  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    const hash = crypto
      .createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex');
    return hash === signature;
  }

  parseWebhookEvent(payload: unknown): WebhookEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as PaystackChargeSuccessPayload;
    if (!p.data) return null;
    const base = {
      amount: p.data.amount / 100, // Paystack amounts are in kobo
      reference: p.data.reference,
      metadata: p.data.metadata,
    };
    if (p.event === 'charge.success') {
      return {
        ...base,
        event: 'payment',
        // ARCH-13 — order-bound charges carry metadata.orderId or
        // metadata.transactionId. Virtual-account funding events use
        // metadata.userId, which keeps `kind: 'payment'` so the
        // existing wallet-topup handler still fires.
        kind:
          base.metadata?.orderId || base.metadata?.transactionId
            ? 'charge_succeeded'
            : 'payment',
      };
    }
    if (p.event === 'charge.failed') {
      return { ...base, event: 'payment', kind: 'charge_failed' };
    }
    return null;
  }
}
