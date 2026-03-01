export interface VirtualAccountResult {
  accountNumber: string;
  bankName: string;
  accountName: string;
  providerReference: string;
  provider: string;
}

export interface WebhookEvent {
  event: string;
  amount: number;
  reference: string;
  metadata?: any;
}

export interface IPaymentGateway {
  createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult>;

  verifyWebhookSignature(payload: Buffer, signature: string): boolean;

  parseWebhookEvent(payload: any): WebhookEvent | null;
}
