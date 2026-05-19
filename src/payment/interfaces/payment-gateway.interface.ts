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

export interface IPaymentGateway {
  createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult>;

  initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult>;

  verifyWebhookSignature(payload: Buffer, signature: string): boolean;

  parseWebhookEvent(payload: unknown): WebhookEvent | null;
}
