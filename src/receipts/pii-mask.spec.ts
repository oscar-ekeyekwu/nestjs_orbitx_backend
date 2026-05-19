import { maskEmail, maskPhone } from './pii-mask';

describe('pii-mask (E4)', () => {
  describe('maskPhone', () => {
    it('masks the middle digits of an E.164 Nigerian number', () => {
      // 14 chars, 4 + 4 visible → 6 stars between.
      expect(maskPhone('+2348012345678')).toBe('+234******5678');
    });

    it('masks a local Nigerian number', () => {
      // 11 chars, 4 + 4 visible → 3 stars between.
      expect(maskPhone('08012345678')).toBe('0801***5678');
    });

    it('leaves very short strings alone', () => {
      expect(maskPhone('1234')).toBe('1234');
      expect(maskPhone('12345678')).toBe('12345678');
    });

    it('returns empty string for falsy input', () => {
      expect(maskPhone(null)).toBe('');
      expect(maskPhone(undefined)).toBe('');
      expect(maskPhone('')).toBe('');
    });
  });

  describe('maskEmail', () => {
    it('preserves the first local char and full domain', () => {
      // local 'chioma' (6 chars) → first 1 visible + 5 stars.
      expect(maskEmail('chioma@example.com')).toBe('c*****@example.com');
    });

    it('handles a one-character local part', () => {
      expect(maskEmail('a@x.io')).toBe('a@x.io');
    });

    it('leaves malformed (no @) input untouched', () => {
      expect(maskEmail('not-an-email')).toBe('not-an-email');
    });

    it('returns empty string for falsy input', () => {
      expect(maskEmail(null)).toBe('');
      expect(maskEmail(undefined)).toBe('');
    });
  });
});
