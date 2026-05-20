import { randomBytes } from 'crypto';
import { StorageCryptoService } from './crypto.service';
import { KEK_BYTE_LENGTH } from './crypto.util';

describe('StorageCryptoService', () => {
  const originalKek = process.env.STORAGE_KEK;

  afterEach(() => {
    if (originalKek === undefined) {
      delete process.env.STORAGE_KEK;
    } else {
      process.env.STORAGE_KEK = originalKek;
    }
  });

  it('throws on construction when STORAGE_KEK is missing — fail-fast on boot', () => {
    delete process.env.STORAGE_KEK;
    expect(() => new StorageCryptoService()).toThrow(/STORAGE_KEK is not set/);
  });

  it('throws on construction when STORAGE_KEK is the wrong byte length', () => {
    process.env.STORAGE_KEK = randomBytes(16).toString('base64');
    expect(() => new StorageCryptoService()).toThrow(
      /must decode to exactly 32 bytes/,
    );
  });

  it('round-trips a plaintext secret end-to-end via DI', () => {
    process.env.STORAGE_KEK = randomBytes(KEK_BYTE_LENGTH).toString('base64');
    const svc = new StorageCryptoService();
    const record = svc.encryptSecret('a-real-spaces-secret-key');
    expect(svc.decryptSecret(record)).toBe('a-real-spaces-secret-key');
  });

  it('masks trailing characters via the exposed helper', () => {
    process.env.STORAGE_KEK = randomBytes(KEK_BYTE_LENGTH).toString('base64');
    const svc = new StorageCryptoService();
    expect(svc.maskTrailing('AKIAIOSFODNN7EXAMPLE')).toBe('••••••MPLE');
  });
});
