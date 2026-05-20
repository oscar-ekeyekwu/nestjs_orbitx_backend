import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * STG-1 — at-rest crypto for storage provider credentials.
 *
 * AES-256-GCM via Node's built-in `crypto` module (no new dep). One 32-byte
 * key-encryption-key (KEK) loaded from `STORAGE_KEK`, surfaced via the
 * `loadStorageKek()` helper. Each credential row carries its own 12-byte
 * nonce + 16-byte GCM tag + a `keyVersion` int so the KEK can be rotated
 * without losing access to existing rows (rotation reads-with-old,
 * re-encrypts-with-new — out of scope for STG-1).
 *
 * Kept as pure functions (no DI) so the bootstrap migration can call
 * `encryptSecret` directly during the seed step without spinning up a
 * Nest module graph.
 */

export const KEK_BYTE_LENGTH = 32;
export const NONCE_BYTE_LENGTH = 12;
export const TAG_BYTE_LENGTH = 16;
export const CURRENT_KEY_VERSION = 1;

export class StorageCredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageCredentialDecryptError';
  }
}

export interface EncryptedSecret {
  cipher: Buffer;
  nonce: Buffer;
  tag: Buffer;
  keyVersion: number;
}

/**
 * Resolve the KEK from the environment. Accepts base64, base64url, or hex
 * encoding — any 32-byte payload after decoding. Returns the raw key as a
 * Buffer. Throws with a clear, fail-fast message if the var is missing,
 * empty, or the wrong byte length.
 *
 * The exposed env var is `STORAGE_KEK`. The bootstrap migration calls this
 * helper directly; the NestJS-side `CryptoService` calls it from its
 * constructor so a misconfigured boot blows up before the HTTP listener
 * starts.
 */
export function loadStorageKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.STORAGE_KEK;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      'STORAGE_KEK is not set. Generate one with `openssl rand -base64 32` and set it as an environment variable. See deploy/README.md for rotation notes.',
    );
  }
  const candidates: Buffer[] = [];
  // base64 / base64url
  try {
    candidates.push(Buffer.from(raw, 'base64'));
  } catch {
    // ignore — try the next decoding below
  }
  // hex
  if (/^[0-9a-fA-F]+$/.test(raw)) {
    try {
      candidates.push(Buffer.from(raw, 'hex'));
    } catch {
      // ignore
    }
  }
  const match = candidates.find((buf) => buf.length === KEK_BYTE_LENGTH);
  if (!match) {
    throw new Error(
      `STORAGE_KEK must decode to exactly ${KEK_BYTE_LENGTH} bytes (got ${candidates
        .map((c) => c.length)
        .join(
          ' / ',
        )} after trying base64/hex). Regenerate with \`openssl rand -base64 32\`.`,
    );
  }
  return match;
}

export function encryptSecret(plaintext: string, kek: Buffer): EncryptedSecret {
  if (kek.length !== KEK_BYTE_LENGTH) {
    throw new Error(
      `KEK must be ${KEK_BYTE_LENGTH} bytes; received ${kek.length}`,
    );
  }
  const nonce = randomBytes(NONCE_BYTE_LENGTH);
  const cipherer = createCipheriv('aes-256-gcm', kek, nonce);
  const cipher = Buffer.concat([
    cipherer.update(plaintext, 'utf8'),
    cipherer.final(),
  ]);
  const tag = cipherer.getAuthTag();
  return { cipher, nonce, tag, keyVersion: CURRENT_KEY_VERSION };
}

export function decryptSecret(record: EncryptedSecret, kek: Buffer): string {
  if (kek.length !== KEK_BYTE_LENGTH) {
    throw new StorageCredentialDecryptError(
      `KEK must be ${KEK_BYTE_LENGTH} bytes; received ${kek.length}`,
    );
  }
  if (record.nonce.length !== NONCE_BYTE_LENGTH) {
    throw new StorageCredentialDecryptError(
      `Nonce must be ${NONCE_BYTE_LENGTH} bytes; received ${record.nonce.length}`,
    );
  }
  if (record.tag.length !== TAG_BYTE_LENGTH) {
    throw new StorageCredentialDecryptError(
      `Auth tag must be ${TAG_BYTE_LENGTH} bytes; received ${record.tag.length}`,
    );
  }
  if (record.keyVersion !== CURRENT_KEY_VERSION) {
    throw new StorageCredentialDecryptError(
      `Unsupported keyVersion ${record.keyVersion}; current is ${CURRENT_KEY_VERSION}`,
    );
  }
  try {
    const decipherer = createDecipheriv('aes-256-gcm', kek, record.nonce);
    decipherer.setAuthTag(record.tag);
    const decoded = Buffer.concat([
      decipherer.update(record.cipher),
      decipherer.final(),
    ]);
    return decoded.toString('utf8');
  } catch (err) {
    throw new StorageCredentialDecryptError(
      `Failed to decrypt storage credential (possible KEK mismatch or tampered ciphertext): ${(err as Error).message}`,
    );
  }
}

/** Render the last 4 characters of a secret for safe display. */
export function maskTrailing(plain: string, visible = 4): string {
  if (!plain) return '';
  const tail = plain.slice(-visible);
  return `••••••${tail}`;
}
