/**
 * Partial-mask helpers for receipt rendering (DR-N5).
 *
 * Receipts are emailed / SMSed and may be forwarded; rendering the
 * customer's full phone or email gives a downstream reader more than
 * they need. We keep enough characters to be recognizable to the
 * legitimate owner while obscuring the rest.
 */

/**
 * Mask a phone number to first 4 + last 4 digits, e.g.:
 *   '+2348012345678' -> '+234*******5678'
 *   '08012345678'    -> '0801***5678'
 * Returns the empty string for falsy input so callers don't render
 * "undefined" as a literal.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const trimmed = phone.trim();
  if (trimmed.length <= 8) return trimmed;
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  const mid = '*'.repeat(
    Math.max(trimmed.length - head.length - tail.length, 1),
  );
  return `${head}${mid}${tail}`;
}

/**
 * Mask an email by preserving the first character of the local part
 * and the full domain, e.g.:
 *   'chioma@example.com' -> 'c******@example.com'
 *   'ab@x.io'            -> 'a*@x.io'
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 1) return `${local}${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 1)}${domain}`;
}
