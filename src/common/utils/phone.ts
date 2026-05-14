/**
 * Nigeria-specific phone number normalization (E.164 with +234).
 *
 * Project context: OrbitX is Nigeria-only for now. A full libphonenumber-js
 * dependency would be ~100KB for a single country code, so we keep a tiny
 * country-specific helper here. If the platform expands beyond Nigeria,
 * swap this for libphonenumber-js — same API.
 *
 * Accepted inputs (all map to +234XXXXXXXXXX):
 *   - 08123456789  (local 11-digit, leading 0)
 *   - 8123456789   (local 10-digit, no leading 0)
 *   - +2348123456789  (already E.164)
 *   - 2348123456789   (country code, no plus)
 *   - "+234 812 345 6789", "0812-345-6789" (whitespace / punctuation tolerated)
 *
 * Returns null for inputs that don't match the Nigerian mobile pattern.
 */
const COUNTRY_CODE = '234';
const NIGERIA_MOBILE_DIGITS = 10; // length after +234

export function normalizeNigerianPhone(
  input: string | null | undefined,
): string | null {
  if (!input) return null;

  // Strip every non-digit (we'll re-add the + at the end).
  const digits = input.replace(/\D+/g, '');

  if (digits.length === 0) return null;

  // Case 1: already includes 234 country code (12 or 13 digits).
  if (
    digits.startsWith(COUNTRY_CODE) &&
    digits.length === COUNTRY_CODE.length + NIGERIA_MOBILE_DIGITS
  ) {
    return `+${digits}`;
  }

  // Case 2: 11 digits starting with 0 (local format).
  if (digits.length === NIGERIA_MOBILE_DIGITS + 1 && digits.startsWith('0')) {
    return `+${COUNTRY_CODE}${digits.slice(1)}`;
  }

  // Case 3: 10 digits, no leading zero.
  if (digits.length === NIGERIA_MOBILE_DIGITS) {
    return `+${COUNTRY_CODE}${digits}`;
  }

  return null;
}

/** True if the input normalizes cleanly to a Nigerian E.164 number. */
export function isValidNigerianPhone(
  input: string | null | undefined,
): boolean {
  return normalizeNigerianPhone(input) !== null;
}
