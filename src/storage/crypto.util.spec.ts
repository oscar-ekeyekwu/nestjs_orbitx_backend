import { randomBytes } from 'crypto';
import {
  CURRENT_KEY_VERSION,
  decryptSecret,
  encryptSecret,
  KEK_BYTE_LENGTH,
  loadStorageKek,
  maskTrailing,
  NONCE_BYTE_LENGTH,
  StorageCredentialDecryptError,
  TAG_BYTE_LENGTH,
} from './crypto.util';

describe('storage/crypto.util', () => {
  const validKek = randomBytes(KEK_BYTE_LENGTH);

  describe('loadStorageKek', () => {
    it('decodes a base64-encoded 32-byte key', () => {
      const kek = randomBytes(KEK_BYTE_LENGTH).toString('base64');
      const decoded = loadStorageKek({ STORAGE_KEK: kek });
      expect(decoded.length).toBe(KEK_BYTE_LENGTH);
    });

    it('decodes a hex-encoded 32-byte key', () => {
      const kek = randomBytes(KEK_BYTE_LENGTH).toString('hex');
      const decoded = loadStorageKek({ STORAGE_KEK: kek });
      expect(decoded.length).toBe(KEK_BYTE_LENGTH);
    });

    it('throws when STORAGE_KEK is missing', () => {
      expect(() => loadStorageKek({})).toThrow(/STORAGE_KEK is not set/);
    });

    it('throws when STORAGE_KEK is the empty string', () => {
      expect(() => loadStorageKek({ STORAGE_KEK: '   ' })).toThrow(
        /STORAGE_KEK is not set/,
      );
    });

    it('throws when STORAGE_KEK decodes to the wrong byte length', () => {
      // 16 raw bytes — too short
      const shortKek = randomBytes(16).toString('base64');
      expect(() => loadStorageKek({ STORAGE_KEK: shortKek })).toThrow(
        /must decode to exactly 32 bytes/,
      );
    });
  });

  describe('encryptSecret / decryptSecret', () => {
    it('round-trips a plaintext secret', () => {
      const record = encryptSecret('my-spaces-secret', validKek);
      expect(record.nonce.length).toBe(NONCE_BYTE_LENGTH);
      expect(record.tag.length).toBe(TAG_BYTE_LENGTH);
      expect(record.keyVersion).toBe(CURRENT_KEY_VERSION);
      expect(decryptSecret(record, validKek)).toBe('my-spaces-secret');
    });

    it('produces a different ciphertext for the same plaintext on repeat calls', () => {
      const a = encryptSecret('same', validKek);
      const b = encryptSecret('same', validKek);
      expect(Buffer.compare(a.cipher, b.cipher) === 0).toBe(false);
      // Different nonces — the whole point of AES-GCM IV uniqueness.
      expect(Buffer.compare(a.nonce, b.nonce) === 0).toBe(false);
    });

    it('rejects decryption with a different KEK (tag mismatch)', () => {
      const record = encryptSecret('secret', validKek);
      const otherKek = randomBytes(KEK_BYTE_LENGTH);
      expect(() => decryptSecret(record, otherKek)).toThrow(
        StorageCredentialDecryptError,
      );
    });

    it('rejects decryption when the tag has been tampered with', () => {
      const record = encryptSecret('secret', validKek);
      const tampered = {
        ...record,
        tag: Buffer.from(record.tag).fill(0),
      };
      expect(() => decryptSecret(tampered, validKek)).toThrow(
        StorageCredentialDecryptError,
      );
    });

    it('rejects decryption when the ciphertext has been tampered with', () => {
      const record = encryptSecret('secret', validKek);
      const tampered = {
        ...record,
        cipher: Buffer.from(record.cipher).fill(0xff),
      };
      expect(() => decryptSecret(tampered, validKek)).toThrow(
        StorageCredentialDecryptError,
      );
    });

    it('rejects decryption when the nonce has been tampered with', () => {
      const record = encryptSecret('secret', validKek);
      const tampered = {
        ...record,
        nonce: Buffer.from(record.nonce).fill(1),
      };
      expect(() => decryptSecret(tampered, validKek)).toThrow(
        StorageCredentialDecryptError,
      );
    });

    it('rejects decryption when keyVersion is unsupported', () => {
      const record = encryptSecret('secret', validKek);
      expect(() =>
        decryptSecret({ ...record, keyVersion: 999 }, validKek),
      ).toThrow(/Unsupported keyVersion/);
    });

    it('rejects a malformed nonce length', () => {
      const record = encryptSecret('secret', validKek);
      expect(() =>
        decryptSecret({ ...record, nonce: Buffer.alloc(8) }, validKek),
      ).toThrow(/Nonce must be 12 bytes/);
    });

    it('rejects a malformed tag length', () => {
      const record = encryptSecret('secret', validKek);
      expect(() =>
        decryptSecret({ ...record, tag: Buffer.alloc(8) }, validKek),
      ).toThrow(/Auth tag must be 16 bytes/);
    });
  });

  describe('maskTrailing', () => {
    it('renders the last 4 chars with leading bullets', () => {
      expect(maskTrailing('AKIAIOSFODNN7EXAMPLE')).toBe('••••••MPLE');
    });

    it('returns empty string for falsy input', () => {
      expect(maskTrailing('')).toBe('');
    });

    it('respects the visible-count override', () => {
      expect(maskTrailing('hello', 2)).toBe('••••••lo');
    });
  });
});
