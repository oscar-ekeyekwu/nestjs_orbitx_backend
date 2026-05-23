import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import type {
  CreateTransferInput,
  CreateTransferResult,
  InitializePaymentInput,
  InitializePaymentResult,
  IPaymentGateway,
  TestConnectionResult,
  VerifyPaymentResult,
  VirtualAccountResult,
  WebhookEvent,
  WebhookEventMetadata,
} from '../interfaces/payment-gateway.interface';

export interface PaystackGatewayConfig {
  providerId: string;
  providerSlug: string;
  baseUrl: string;
  secretKey: string;
  /**
   * Optional dedicated webhook signing secret. When unset, falls back
   * to `secretKey` — Paystack's documented signature scheme uses the
   * main secret. Storing them separately lets future-Paystack (or
   * other gateways that mandate it) drop in without a schema change.
   */
  webhookSecret?: string | null;
  /**
   * Preferred bank slug for the DVA assign call. Paystack live mode
   * supports `wema-bank`, `access-bank`, `titan-paystack`; test mode
   * supports only `test-bank`. Null/undefined lets the adapter pick
   * a sensible default from the secret-key prefix.
   */
  preferredBank?: string | null;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

interface PaystackCustomer {
  customer_code: string;
  // Returned by GET /customer/:code|email after a DVA assign completes.
  // Paystack has surfaced both singular (`dedicated_account`) and
  // plural (`dedicated_accounts`) shapes in different doc revisions;
  // we accept either.
  dedicated_account?: PaystackDedicatedAccount;
  dedicated_accounts?: PaystackDedicatedAccount[];
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
    customer?: {
      customer_code?: string;
      email?: string;
      metadata?: WebhookEventMetadata;
    };
    authorization?: {
      receiver_bank_account_number?: string;
      sender_bank_account_number?: string;
    };
  };
}

interface PaystackInitializeResponse {
  access_code: string;
  reference: string;
  authorization_url: string;
}

interface PaystackVerifyResponse {
  reference: string;
  /** Paystack returns 'success', 'failed', 'abandoned', 'pending', etc. */
  status: string;
  amount: number; // kobo
}

interface PaystackTransferResponse {
  transfer_code: string;
  reference: string;
  /** Paystack returns 'success' | 'pending' | 'failed' | 'reversed'. */
  status: string;
}

/**
 * PAY-1 — Paystack adapter. Pure class (no Nest DI in the constructor)
 * so the PaymentGatewayRegistry can instantiate one per provider row,
 * with credentials decrypted just-in-time. Logger is class-scoped.
 */
export class PaystackGateway implements IPaymentGateway {
  private readonly logger = new Logger(PaystackGateway.name);
  readonly providerId: string;
  readonly providerSlug: string;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly configuredPreferredBank: string | null;

  constructor(config: PaystackGatewayConfig) {
    this.providerId = config.providerId;
    this.providerSlug = config.providerSlug;
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret || config.secretKey;
    this.baseUrl = config.baseUrl;
    this.configuredPreferredBank = config.preferredBank ?? null;
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
        // Paystack live mode supports wema-bank / access-bank / titan-paystack;
        // test mode only supports `test-bank`. Sniff the key prefix so a
        // staging deploy with an sk_test_… key doesn't fail at DVA assign.
        preferred_bank: this.preferredDvaBank(),
        country: 'NG',
        customer: customerCode,
      }),
    });

    const dvaData =
      (await dvaRes.json()) as PaystackEnvelope<PaystackDedicatedAccount>;

    if (dvaData.status && dvaData.data) {
      return this.toVirtualAccountResult(dvaData.data);
    }

    // Paystack's `dedicated_account/assign` is async for some banks
    // (test-bank in test mode, Wema/Access on first-time provisioning).
    // A retry hits "Assign dedicated account in progress" because the
    // previous request is still being processed. Look up the customer
    // — if a DVA has landed since, return it; otherwise raise a clear
    // "still provisioning" error the caller can present + retry on.
    const inProgress = (dvaData.message ?? '')
      .toLowerCase()
      .includes('in progress');
    if (inProgress) {
      this.logger.warn(
        `Paystack DVA assign reported in-progress for ${params.email}; falling back to customer lookup.`,
      );
      const existing = await this.fetchExistingDedicatedAccount(customerCode);
      if (existing) {
        return this.toVirtualAccountResult(existing);
      }
      throw new Error(
        'Virtual account is still being provisioned by Paystack. Wait a few seconds and try again.',
      );
    }

    throw new Error(
      `Failed to create virtual account: ${dvaData.message ?? 'Unknown error'}`,
    );
  }

  private toVirtualAccountResult(
    account: PaystackDedicatedAccount,
  ): VirtualAccountResult {
    return {
      accountNumber: account.account_number,
      bankName:
        account.bank?.name ??
        account.bank_name ??
        (this.isTestMode() ? 'Test Bank' : 'Wema Bank'),
      accountName: account.account_name,
      providerReference: account.id?.toString() ?? account.account_number,
      provider: 'paystack',
    };
  }

  /**
   * GET /customer/:code — used as a fallback when the DVA assign call
   * returns "in progress". Paystack populates `dedicated_account` (or
   * the plural variant) on the customer the moment provisioning
   * completes on their side. Returns null when no account is attached
   * yet (truly still pending).
   */
  private async fetchExistingDedicatedAccount(
    customerCode: string,
  ): Promise<PaystackDedicatedAccount | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/customer/${encodeURIComponent(customerCode)}`,
        { headers: { Authorization: `Bearer ${this.secretKey}` } },
      );
      const data = (await res.json()) as PaystackEnvelope<PaystackCustomer>;
      if (!data.status || !data.data) return null;
      if (data.data.dedicated_account?.account_number) {
        return data.data.dedicated_account;
      }
      const list = data.data.dedicated_accounts ?? [];
      return list.find((row) => !!row.account_number) ?? null;
    } catch (err) {
      this.logger.warn(
        `Paystack customer lookup failed for ${customerCode}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private isTestMode(): boolean {
    return this.secretKey.startsWith('sk_test_');
  }

  /**
   * DVA preferred-bank resolution order:
   *   1. Admin-configured `preferredBank` on the payment_providers row
   *      (so production can target Access / Titan / Wema without
   *      redeploying).
   *   2. `test-bank` when the secret key is in test mode — Paystack
   *      doesn't expose any other bank in test mode.
   *   3. `wema-bank` as the documented live-mode default.
   */
  private preferredDvaBank(): string {
    if (this.configuredPreferredBank) return this.configuredPreferredBank;
    return this.isTestMode() ? 'test-bank' : 'wema-bank';
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

  /**
   * G1 — defensive re-check called when the mobile client returns from
   * the hosted page. Paystack `/transaction/verify/:reference` is
   * idempotent on their side; we map their string `status` into our
   * narrow union.
   */
  async verifyPayment(reference: string): Promise<VerifyPaymentResult> {
    const res = await fetch(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.secretKey}` },
      },
    );
    const envelope =
      (await res.json()) as PaystackEnvelope<PaystackVerifyResponse>;
    if (!envelope.status || !envelope.data) {
      throw new Error(
        `Paystack verify failed: ${envelope.message ?? 'Unknown error'}`,
      );
    }
    const raw = envelope.data.status;
    const status: VerifyPaymentResult['status'] =
      raw === 'success'
        ? 'success'
        : raw === 'failed' || raw === 'abandoned'
          ? 'failed'
          : 'pending';
    return {
      reference: envelope.data.reference,
      status,
      amount: envelope.data.amount / 100,
    };
  }

  /**
   * G4 — outbound transfer to a recipient subaccount. Amount sent in
   * kobo. `reference` is the payout.id; passing it on every retry
   * makes Paystack's API idempotent end-to-end.
   */
  async createTransfer(
    input: CreateTransferInput,
  ): Promise<CreateTransferResult> {
    const amountKobo = Math.round(input.amountNaira * 100);
    const res = await fetch(`${this.baseUrl}/transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'balance',
        amount: amountKobo,
        recipient: input.recipientCode,
        reference: input.reference,
        reason: input.reason,
      }),
    });
    const envelope =
      (await res.json()) as PaystackEnvelope<PaystackTransferResponse>;
    if (!envelope.status || !envelope.data) {
      throw new Error(
        `Paystack transfer failed: ${envelope.message ?? 'Unknown error'}`,
      );
    }
    const rawStatus = envelope.data.status;
    const status: CreateTransferResult['status'] =
      rawStatus === 'success'
        ? 'success'
        : rawStatus === 'pending'
          ? 'pending'
          : 'failed';
    return {
      transferCode: envelope.data.transfer_code,
      reference: envelope.data.reference,
      status,
    };
  }

  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    const hash = crypto
      .createHmac('sha512', this.webhookSecret)
      .update(payload)
      .digest('hex');
    return hash === signature;
  }

  /**
   * PAY-1 — `/balance` is the cheapest authenticated paystack endpoint
   * we can hit. Success proves the secret key is valid + the network
   * path works; failure surfaces a sanitised error so the admin Test
   * button can render something useful without leaking the key.
   */
  async testConnection(): Promise<TestConnectionResult> {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/balance`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        return {
          ok: false,
          error: `Paystack rejected the request (HTTP ${res.status}). Verify the secret key is current.`,
        };
      }
      const envelope = (await res.json()) as PaystackEnvelope<unknown>;
      if (!envelope.status) {
        return {
          ok: false,
          error: `Paystack returned status=false: ${envelope.message ?? 'unknown error'}`,
        };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Network error contacting Paystack: ${message}` };
    }
  }

  parseWebhookEvent(payload: unknown): WebhookEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as PaystackChargeSuccessPayload;
    if (!p.data) return null;
    // Dedicated virtual-account funding events: Paystack puts the
    // userId we tagged at customer-create on `customer.metadata.userId`,
    // not on the charge metadata. Surface it on the normalised
    // metadata so the webhook handler can resolve the wallet without
    // a customer-lookup round-trip. The DVA bank account number
    // (sender / receiver) is also forwarded as a defence-in-depth
    // attribution hook — see PaymentController.paystackWebhook.
    const charge = p.data.metadata ?? {};
    const customerMeta = p.data.customer?.metadata ?? {};
    const mergedMeta: WebhookEventMetadata = {
      ...customerMeta,
      ...charge,
    };
    if (p.data.customer?.customer_code) {
      mergedMeta.customerCode = p.data.customer.customer_code;
    }
    if (p.data.authorization?.receiver_bank_account_number) {
      mergedMeta.receiverAccountNumber =
        p.data.authorization.receiver_bank_account_number;
    }
    const base = {
      amount: p.data.amount / 100, // Paystack amounts are in kobo
      reference: p.data.reference,
      metadata: mergedMeta,
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
