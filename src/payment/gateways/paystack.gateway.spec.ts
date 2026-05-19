import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PaystackGateway } from './paystack.gateway';

const SECRET = 'sk_test_secret';

function buildGateway(): PaystackGateway {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'PAYSTACK_SECRET_KEY') return SECRET;
      if (key === 'PAYSTACK_BASE_URL') return 'https://paystack.test';
      return undefined;
    }),
  } as unknown as ConfigService;
  return new PaystackGateway(config);
}

function signedBody(payload: unknown): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha512', SECRET)
    .update(body)
    .digest('hex');
  return { body, signature };
}

describe('PaystackGateway (ARCH-13)', () => {
  describe('verifyWebhookSignature', () => {
    it('accepts a HMAC-SHA512 signature computed with the configured secret', () => {
      const gateway = buildGateway();
      const { body, signature } = signedBody({ event: 'charge.success' });
      expect(gateway.verifyWebhookSignature(body, signature)).toBe(true);
    });

    it('rejects a tampered body even with the original signature', () => {
      const gateway = buildGateway();
      const { signature } = signedBody({ event: 'charge.success' });
      const tampered = Buffer.from(
        JSON.stringify({ event: 'charge.success', tampered: true }),
      );
      expect(gateway.verifyWebhookSignature(tampered, signature)).toBe(false);
    });

    it('rejects a wholly invalid signature', () => {
      const gateway = buildGateway();
      const { body } = signedBody({ event: 'charge.success' });
      expect(gateway.verifyWebhookSignature(body, 'deadbeef')).toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    it('maps charge.success with metadata.orderId to kind=charge_succeeded', () => {
      const gateway = buildGateway();
      const parsed = gateway.parseWebhookEvent({
        event: 'charge.success',
        data: {
          amount: 450000, // kobo
          reference: 'txn-1',
          metadata: { orderId: 'order-1' },
        },
      });
      expect(parsed).toMatchObject({
        event: 'payment',
        kind: 'charge_succeeded',
        amount: 4500,
        reference: 'txn-1',
      });
    });

    it('keeps the legacy virtual-account funding event as kind=payment', () => {
      const gateway = buildGateway();
      const parsed = gateway.parseWebhookEvent({
        event: 'charge.success',
        data: {
          amount: 100000,
          reference: 'ref-x',
          metadata: { userId: 'user-1' },
        },
      });
      expect(parsed?.kind).toBe('payment');
    });

    it('maps charge.failed to kind=charge_failed', () => {
      const gateway = buildGateway();
      const parsed = gateway.parseWebhookEvent({
        event: 'charge.failed',
        data: { amount: 450000, reference: 'txn-1' },
      });
      expect(parsed?.kind).toBe('charge_failed');
    });

    it('returns null for unknown event types', () => {
      const gateway = buildGateway();
      expect(
        gateway.parseWebhookEvent({
          event: 'transfer.success',
          data: { amount: 0, reference: 'x' },
        }),
      ).toBeNull();
    });

    it('returns null for malformed payloads', () => {
      const gateway = buildGateway();
      expect(gateway.parseWebhookEvent(null)).toBeNull();
      expect(gateway.parseWebhookEvent('not-an-object')).toBeNull();
    });
  });

  describe('initializePayment', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('POSTs amount in kobo + reference + metadata to /transaction/initialize', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () =>
          Promise.resolve({
            status: true,
            data: {
              access_code: 'AC-1',
              reference: 'txn-1',
              authorization_url: 'https://paystack.test/checkout/AC-1',
            },
          }),
      } as never);

      const gateway = buildGateway();
      const result = await gateway.initializePayment({
        transactionId: 'txn-1',
        orderId: 'order-1',
        email: 'chioma@example.com',
        amountNaira: 4500,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { body?: string; headers?: Record<string, string> },
      ];
      expect(url).toBe('https://paystack.test/transaction/initialize');
      const body = JSON.parse(init.body ?? '{}') as {
        amount: number;
        email: string;
        reference: string;
        metadata: Record<string, unknown>;
      };
      expect(body.amount).toBe(450000); // kobo
      expect(body.email).toBe('chioma@example.com');
      expect(body.reference).toBe('txn-1');
      expect(body.metadata).toEqual({
        orderId: 'order-1',
        transactionId: 'txn-1',
      });

      expect(result.authorizationUrl).toBe(
        'https://paystack.test/checkout/AC-1',
      );
    });

    it('throws when Paystack returns status=false', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () =>
          Promise.resolve({ status: false, message: 'invalid amount' }),
      } as never);

      const gateway = buildGateway();
      await expect(
        gateway.initializePayment({
          transactionId: 'txn-1',
          orderId: 'order-1',
          email: 'x@y.com',
          amountNaira: 0,
        }),
      ).rejects.toThrow(/invalid amount/i);
    });
  });
});
