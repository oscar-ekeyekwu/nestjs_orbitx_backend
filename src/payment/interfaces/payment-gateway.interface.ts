export interface VirtualAccountResult {
  accountNumber: string;
  bankName: string;
  accountName: string;
  providerReference: string;
  provider: string;
}

export interface WebhookEventMetadata {
  userId?: string;
  orderId?: string;
  transactionId?: string;
  [key: string]: unknown;
}

/**
 * Normalized webhook event the rest of the platform consumes. Concrete
 * gateways translate provider-specific payloads into this shape.
 *
 * `kind` distinguishes the order-payment path (ARCH-13) from the older
 * virtual-account funding flow which is still served by the same
 * webhook controller.
 */
export interface WebhookEvent {
  event: string;
  /** ARCH-13 — categorizes the event so the handler can route. */
  kind: 'payment' | 'charge_succeeded' | 'charge_failed';
  amount: number;
  reference: string;
  metadata?: WebhookEventMetadata;
}

export interface InitializePaymentInput {
  /** Already-minted transaction id used as the Paystack reference. */
  transactionId: string;
  /** Order this charge belongs to; embedded in metadata for the webhook. */
  orderId: string;
  /** Customer email Paystack will receive the receipt on. */
  email: string;
  /** Amount in Naira; the gateway converts to kobo before hitting Paystack. */
  amountNaira: number;
}

export interface InitializePaymentResult {
  accessCode: string;
  reference: string;
  authorizationUrl: string;
}

/**
 * G1 — Paystack verify response. The mobile WebView hits this after
 * the hosted-page callback so we recover from missed / delayed webhooks.
 * `amount` is in Naira (gateway converts from kobo).
 */
export interface VerifyPaymentResult {
  reference: string;
  status: 'success' | 'failed' | 'pending';
  amount: number;
}

/**
 * G4 — outbound transfer to a recipient's Paystack subaccount.
 * recipientCode is the transfer-recipient identifier Paystack returns
 * from its /transferrecipient setup endpoint.
 */
export interface CreateTransferInput {
  amountNaira: number;
  recipientCode: string;
  /** Unique idempotency key — we pass payout.id so replays are safe. */
  reference: string;
  reason: string;
}

export interface CreateTransferResult {
  transferCode: string;
  reference: string;
  /** 'success' for instant transfers, 'pending' for queued. */
  status: 'success' | 'pending' | 'failed';
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * PAY-1 — contract every gateway adapter implements. Concrete adapters
 * (paystack.gateway, flutterwave.gateway, …) translate provider-specific
 * payloads into these normalized shapes so the rest of the platform
 * doesn't care which gateway is wired up. New gateways drop in by:
 *   1. Implementing this interface as a class that accepts credentials
 *      in its constructor (no ConfigService coupling).
 *   2. Adding a kind to PaymentProviderKind.
 *   3. Wiring the kind → adapter mapping in PaymentGatewayRegistry.
 */
export interface IPaymentGateway {
  /** Provider id the registry uses for cache keys + decoupled tracing. */
  readonly providerId: string;
  readonly providerSlug: string;

  createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult>;

  initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult>;

  /**
   * G1 — re-fetches the canonical Paystack status by reference so the
   * mobile client can compensate for a missed webhook.
   */
  verifyPayment(reference: string): Promise<VerifyPaymentResult>;

  /**
   * G4 — POST /transfer. Returns the transfer code + Paystack's view
   * of whether it settled synchronously or is queued for processing.
   */
  createTransfer(input: CreateTransferInput): Promise<CreateTransferResult>;

  verifyWebhookSignature(payload: Buffer, signature: string): boolean;

  parseWebhookEvent(payload: unknown): WebhookEvent | null;

  /**
   * PAY-1 — admin "Test" button. Hits a lightweight gateway endpoint
   * to confirm the credentials work. Returns latencyMs on success or
   * a sanitised error message on failure (never echoes the secret).
   */
  testConnection(): Promise<TestConnectionResult>;
}
