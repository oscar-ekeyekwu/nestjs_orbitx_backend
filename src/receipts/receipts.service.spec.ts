import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ReceiptsService } from './receipts.service';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { StorageRegistry } from '../storage/storage-registry.service';
import { EmailService } from '../notifications/email.service';
import { SmsService } from '../notifications/sms.service';
import { naira } from '../common/money';

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: '11111111-2222-3333-4444-555566667777',
    customerId: 'customer-1',
    customer: {
      id: 'customer-1',
      name: 'Chioma Okeke',
      email: 'chioma@example.com',
      phone: '+2348012345678',
    } as never,
    driverId: 'driver-1',
    status: OrderStatus.DELIVERED,
    pickupAddress: '15 Allen Avenue, Ikeja',
    deliveryAddress: '7B Awolowo Road, Ikoyi',
    pickupLatitude: 6.5,
    pickupLongitude: 3.4,
    deliveryLatitude: 6.4,
    deliveryLongitude: 3.5,
    packageSize: 'small',
    recipientName: 'R',
    recipientPhone: '+2348011111111',
    packageDescription: 'pkg',
    estimatedPrice: naira('4500'),
    deliveredAt: new Date('2026-05-19T14:35:00.000Z'),
    createdAt: new Date('2026-05-19T13:00:00.000Z'),
    updatedAt: new Date('2026-05-19T14:35:00.000Z'),
    ...overrides,
  } as Order;
}

describe('ReceiptsService (E4 — end-to-end dispatch)', () => {
  let service: ReceiptsService;
  let ordersRepo: { findOne: jest.Mock };
  let storage: { uploadBuffer: jest.Mock; generateViewUrl: jest.Mock };
  let storageRegistry: { getActive: jest.Mock };
  let email: { sendEmail: jest.Mock };
  let sms: { sendSms: jest.Mock };

  beforeEach(async () => {
    ordersRepo = { findOne: jest.fn() };
    storage = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      generateViewUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example.com/receipt.pdf'),
    };
    // STG-1 — ReceiptsService now resolves an adapter via the registry.
    // `getActive()` returns the (mocked) adapter exposing the two methods
    // E4 actually touches: uploadBuffer + generateViewUrl.
    storageRegistry = {
      getActive: jest.fn().mockResolvedValue(storage),
    };
    email = { sendEmail: jest.fn().mockResolvedValue({ success: true }) };
    sms = { sendSms: jest.fn().mockResolvedValue({ success: true }) };

    const mod = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        { provide: getRepositoryToken(Order), useValue: ordersRepo },
        { provide: StorageRegistry, useValue: storageRegistry },
        { provide: EmailService, useValue: email },
        { provide: SmsService, useValue: sms },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    service = mod.get(ReceiptsService);
  });

  it('renders, uploads under receipts/<orderId>.pdf, and emails when email is present', async () => {
    ordersRepo.findOne.mockResolvedValueOnce(buildOrder());

    const out = await service.generateForOrder(
      '11111111-2222-3333-4444-555566667777',
    );

    expect(out.objectKey).toBe(
      'receipts/11111111-2222-3333-4444-555566667777.pdf',
    );
    expect(out.channel).toBe('email');
    expect(out.receiptUrl).toBe('https://signed.example.com/receipt.pdf');

    expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = storage.uploadBuffer.mock.calls[0] as [
      string,
      Buffer,
      string,
    ];
    expect(key).toBe('receipts/11111111-2222-3333-4444-555566667777.pdf');
    expect(body).toBeInstanceOf(Buffer);
    expect(body.length).toBeGreaterThan(0);
    expect(body.subarray(0, 4).toString()).toBe('%PDF');
    expect(contentType).toBe('application/pdf');

    expect(storage.generateViewUrl).toHaveBeenCalledWith(
      'receipts/11111111-2222-3333-4444-555566667777.pdf',
      7 * 24 * 60 * 60,
    );
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  it('falls back to SMS when the customer has no email', async () => {
    ordersRepo.findOne.mockResolvedValueOnce(
      buildOrder({
        customer: {
          id: 'customer-1',
          name: 'Chioma',
          email: null,
          phone: '+2348012345678',
        } as never,
      }),
    );

    const out = await service.generateForOrder('order-1');
    expect(out.channel).toBe('sms');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    const [, smsBody] = sms.sendSms.mock.calls[0] as [string, string];
    expect(smsBody).toContain('https://signed.example.com/receipt.pdf');
    // Naira amount also surfaces in the SMS body.
    expect(smsBody).toMatch(/4[,.]?500/);
  });

  it('falls back to SMS when the email dispatch rejects', async () => {
    ordersRepo.findOne.mockResolvedValueOnce(buildOrder());
    email.sendEmail.mockRejectedValueOnce(new Error('smtp down'));

    const out = await service.generateForOrder('order-1');
    expect(out.channel).toBe('sms');
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
  });

  it('returns channel=none when neither email nor phone are on file', async () => {
    ordersRepo.findOne.mockResolvedValueOnce(
      buildOrder({
        customer: {
          id: 'customer-1',
          name: 'X',
          email: null,
          phone: null,
        } as never,
      }),
    );

    const out = await service.generateForOrder('order-1');
    expect(out.channel).toBe('none');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(sms.sendSms).not.toHaveBeenCalled();
    // Upload still happens — the file is available for replay later.
    expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('does NOT leak the raw email into the dispatch body', async () => {
    ordersRepo.findOne.mockResolvedValueOnce(buildOrder());

    await service.generateForOrder('order-1');
    // The email body does include the address in the "to" field on the
    // sendEmail call, but the masked address is what appears in the html
    // body — confirm both, since the html body is what may end up archived.
    const [to, , html] = email.sendEmail.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(to).toBe('chioma@example.com');
    expect(html).not.toContain('chioma@example.com');
  });

  it('throws when the order does not exist', async () => {
    ordersRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.generateForOrder('missing')).rejects.toThrow(
      /not found/i,
    );
  });
});
