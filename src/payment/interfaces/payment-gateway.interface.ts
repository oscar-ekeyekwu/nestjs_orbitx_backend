export interface VirtualAccountResult {
  accountNumber: string;
  bankName: string;
  accountName: string;
  providerReference: string;
  provider: string;
}

export interface WebhookEventMetadata {
  userId?: string;
  [key: string]: unknown;
}

export interface WebhookEvent {
  event: string;
  amount: number;
  reference: string;
  metadata?: WebhookEventMetadata;
}

export interface IPaymentGateway {
  createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult>;

  verifyWebhookSignature(payload: Buffer, signature: string): boolean;

  parseWebhookEvent(payload: unknown): WebhookEvent | null;
}
