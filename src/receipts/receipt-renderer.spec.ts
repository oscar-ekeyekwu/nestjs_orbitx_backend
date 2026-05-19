import {
  buildReceiptContent,
  renderReceipt,
  type ReceiptInput,
} from './receipt-renderer';

const sample: ReceiptInput = {
  orderShortId: '66667777',
  customerName: 'Chioma Okeke',
  customerEmail: 'chioma@example.com',
  customerPhone: '+2348012345678',
  pickupAddress: '15 Allen Avenue, Ikeja',
  deliveryAddress: '7B Awolowo Road, Ikoyi',
  packageSize: 'small',
  totalNaira: 4500,
  paymentMethod: 'Cash on delivery',
  transactionRef: 'TXN-ABC123',
  completedAtIso: '2026-05-19T14:35:00.000Z',
  nipostLicense: 'NIPOST/COURIER/0001',
};

function findValue(
  content: ReturnType<typeof buildReceiptContent>,
  label: string,
): string | undefined {
  return content.fields.find((f) => f.label === label)?.value;
}

describe('buildReceiptContent (E4 — receipt body)', () => {
  it('includes every E4-required field in the expected order', () => {
    const content = buildReceiptContent(sample);
    const labels = content.fields.map((f) => f.label);

    expect(labels).toEqual([
      'Order',
      'Customer',
      'Email',
      'Phone',
      'Pickup',
      'Delivery',
      'Package',
      'Total',
      'Payment',
      'Transaction',
      'Completed',
    ]);

    expect(findValue(content, 'Order')).toBe('#66667777');
    expect(findValue(content, 'Customer')).toBe('Chioma Okeke');
    expect(findValue(content, 'Pickup')).toBe('15 Allen Avenue, Ikeja');
    expect(findValue(content, 'Delivery')).toBe('7B Awolowo Road, Ikoyi');
    expect(findValue(content, 'Package')).toBe('Small');
    expect(findValue(content, 'Payment')).toBe('Cash on delivery');
    expect(findValue(content, 'Transaction')).toBe('TXN-ABC123');
    expect(findValue(content, 'Total')).toMatch(/^₦4[,.]?500$/);
  });

  it('masks email + phone — raw values never appear in any field', () => {
    const content = buildReceiptContent(sample);
    const allValues = content.fields.map((f) => f.value).join(' | ');

    expect(allValues).not.toContain('chioma@example.com');
    expect(findValue(content, 'Email')).toBe('c*****@example.com');

    expect(allValues).not.toContain('+2348012345678');
    expect(findValue(content, 'Phone')).toMatch(/^\+234\*+5678$/);
  });

  it('formats Completed in Africa/Lagos (UTC+1) with WAT suffix', () => {
    const content = buildReceiptContent(sample);
    const completed = findValue(content, 'Completed') ?? '';
    expect(completed).toMatch(/19 May 2026/);
    expect(completed).toMatch(/WAT/);
    // 14:35 UTC -> 15:35 in Africa/Lagos; en-NG locale renders 24h.
    expect(completed).toMatch(/(?:^|\D)(?:15|3):35/);
  });

  it('falls back to a placeholder NIPOST footer when no licence is supplied', () => {
    const content = buildReceiptContent({ ...sample, nipostLicense: null });
    expect(content.footer).toMatch(/interim approval/i);
  });

  it('omits the email line entirely when customerEmail is null', () => {
    const content = buildReceiptContent({ ...sample, customerEmail: null });
    expect(content.fields.find((f) => f.label === 'Email')).toBeUndefined();
  });

  it('omits the phone line entirely when customerPhone is null', () => {
    const content = buildReceiptContent({ ...sample, customerPhone: null });
    expect(content.fields.find((f) => f.label === 'Phone')).toBeUndefined();
  });

  it('omits the transaction line when transactionRef is null', () => {
    const content = buildReceiptContent({ ...sample, transactionRef: null });
    expect(
      content.fields.find((f) => f.label === 'Transaction'),
    ).toBeUndefined();
  });
});

describe('renderReceipt (E4 — PDF integration)', () => {
  it('returns a non-empty PDF buffer with the magic header', async () => {
    const buf = await renderReceipt(sample);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
