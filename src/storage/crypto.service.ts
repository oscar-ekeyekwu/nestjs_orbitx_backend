import { Injectable } from '@nestjs/common';
import {
  decryptSecret,
  encryptSecret,
  loadStorageKek,
  maskTrailing,
  type EncryptedSecret,
} from './crypto.util';

/**
 * NestJS-DI wrapper around the pure helpers in `crypto.util`. The KEK is
 * resolved once at construction time so a misconfigured deploy fails on
 * boot rather than at the first credential decrypt.
 */
@Injectable()
export class StorageCryptoService {
  private readonly kek: Buffer;

  constructor() {
    this.kek = loadStorageKek();
  }

  encryptSecret(plaintext: string): EncryptedSecret {
    return encryptSecret(plaintext, this.kek);
  }

  decryptSecret(record: EncryptedSecret): string {
    return decryptSecret(record, this.kek);
  }

  maskTrailing(plain: string, visible?: number): string {
    return maskTrailing(plain, visible);
  }
}
