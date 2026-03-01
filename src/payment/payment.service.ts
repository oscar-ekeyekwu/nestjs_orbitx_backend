import { Inject, Injectable } from '@nestjs/common';
import {
  IPaymentGateway,
  VirtualAccountResult,
  WebhookEvent,
} from './interfaces/payment-gateway.interface';

@Injectable()
export class PaymentService {
  constructor(
    @Inject('PAYMENT_GATEWAY')
    private readonly gateway: IPaymentGateway,
  ) {}

  createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult> {
    return this.gateway.createVirtualAccount(params);
  }

  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    return this.gateway.verifyWebhookSignature(payload, signature);
  }

  parseWebhookEvent(payload: any): WebhookEvent | null {
    return this.gateway.parseWebhookEvent(payload);
  }
}
