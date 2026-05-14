import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type {
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
    if (p.event === 'charge.success' && p.data) {
      return {
        event: 'payment',
        amount: p.data.amount / 100, // Paystack amounts are in kobo
        reference: p.data.reference,
        metadata: p.data.metadata,
      };
    }
    return null;
  }
}
