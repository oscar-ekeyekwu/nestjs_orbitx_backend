import PDFDocument from 'pdfkit';
import { maskEmail, maskPhone } from './pii-mask';

/**
 * Stable, narrow input shape so the renderer can be unit-tested without
 * loading the full Order / User entities. The receipts service maps
 * those entities into this shape before calling.
 */
export interface ReceiptInput {
  orderShortId: string; // last 8 chars of order.id, what we show on screen
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  pickupAddress: string;
  deliveryAddress: string;
  packageSize: string | null;
  totalNaira: number; // already in naira, not kobo
  paymentMethod: string;
  transactionRef: string | null;
  completedAtIso: string; // ISO timestamp; renderer formats to Africa/Lagos
  nipostLicense: string | null;
}

export interface ReceiptLine {
  label: string;
  value: string;
}

export interface ReceiptContent {
  title: string;
  generatedAt: string;
  fields: ReceiptLine[];
  footer: string;
}

const FIELD_LABEL = {
  orderId: 'Order',
  customer: 'Customer',
  email: 'Email',
  phone: 'Phone',
  pickup: 'Pickup',
  delivery: 'Delivery',
  packageSize: 'Package',
  total: 'Total',
  paymentMethod: 'Payment',
  transactionRef: 'Transaction',
  completedAt: 'Completed',
  nipost: 'NIPOST',
} as const;

/**
 * Pure function: turn the receipt input into the ordered list of lines
 * that will be drawn onto the PDF. Easy to test against (string-only)
 * without parsing PDF byte streams. Also the single source of truth
 * for which fields appear on the receipt + in what order.
 */
export function buildReceiptContent(
  input: ReceiptInput,
  options: { now?: Date } = {},
): ReceiptContent {
  const fields: ReceiptLine[] = [];
  fields.push({ label: FIELD_LABEL.orderId, value: `#${input.orderShortId}` });
  fields.push({ label: FIELD_LABEL.customer, value: input.customerName });
  if (input.customerEmail) {
    fields.push({
      label: FIELD_LABEL.email,
      value: maskEmail(input.customerEmail),
    });
  }
  if (input.customerPhone) {
    fields.push({
      label: FIELD_LABEL.phone,
      value: maskPhone(input.customerPhone),
    });
  }
  fields.push({ label: FIELD_LABEL.pickup, value: input.pickupAddress });
  fields.push({ label: FIELD_LABEL.delivery, value: input.deliveryAddress });
  if (input.packageSize) {
    fields.push({
      label: FIELD_LABEL.packageSize,
      value: capitalize(input.packageSize),
    });
  }
  fields.push({
    label: FIELD_LABEL.total,
    value: formatNaira(input.totalNaira),
  });
  fields.push({ label: FIELD_LABEL.paymentMethod, value: input.paymentMethod });
  if (input.transactionRef) {
    fields.push({
      label: FIELD_LABEL.transactionRef,
      value: input.transactionRef,
    });
  }
  fields.push({
    label: FIELD_LABEL.completedAt,
    value: formatLagosDateTime(input.completedAtIso),
  });

  const footer = input.nipostLicense
    ? `${FIELD_LABEL.nipost} licence: ${input.nipostLicense}`
    : `${FIELD_LABEL.nipost} licence: pending (operated under interim approval)`;

  return {
    title: 'Orbit Delivery Receipt',
    generatedAt: `Generated ${formatLagosDateTime(
      (options.now ?? new Date()).toISOString(),
    )}`,
    fields,
    footer,
  };
}

/**
 * Render a one-page customer receipt to an in-memory PDF buffer.
 * The content comes from `buildReceiptContent` so the textual contract
 * stays testable independent of PDFKit's serialization.
 */
export async function renderReceipt(
  input: ReceiptInput,
  options: { now?: Date } = {},
): Promise<Buffer> {
  const content = buildReceiptContent(input, options);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fontSize(20).text(content.title, { align: 'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text(content.generatedAt);
  doc.moveDown(1).fillColor('#000');

  for (const line of content.fields) {
    writeRow(doc, line.label, line.value);
  }

  doc.moveDown(1).fontSize(9).fillColor('#666').text(content.footer);
  doc.end();
  return done;
}

function writeRow(doc: PDFKit.PDFDocument, label: string, value: string): void {
  const startY = doc.y;
  doc.fontSize(10).fillColor('#666');
  doc.text(label, 50, startY, { width: 110 });
  doc.fontSize(11).fillColor('#000');
  doc.text(value, 170, startY, { width: 380 });
  doc.moveDown(0.6);
}

function formatNaira(amount: number): string {
  const formatted = Math.round(amount).toLocaleString('en-NG');
  return `₦${formatted}`;
}

function formatLagosDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString('en-NG', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
  const timePart = d.toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
  return `${datePart}, ${timePart} WAT`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}
