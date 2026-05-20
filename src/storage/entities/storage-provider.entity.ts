import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum StorageProviderKind {
  S3_COMPATIBLE = 's3_compatible',
}

/**
 * STG-1 — durable registry of credential-bearing storage backends. Every
 * `documents.storage_provider_id` references one of these rows; the
 * `system_configs['storage.activeProviderId']` key names which one new
 * uploads should land in. Credentials are encrypted at rest via the
 * `StorageCryptoService` (AES-256-GCM, KEK from `STORAGE_KEK`).
 *
 * Schema invariants worth preserving:
 *  - `slug` is immutable after creation (foreign-key audit stability).
 *  - `secretCipher / secretNonce / secretTag / keyVersion` are co-tenant —
 *    rotated together when an admin rewrites the secret.
 *  - The plaintext secret access key is never persisted or logged. The
 *    public API responses serialise a `{ masked, updatedAt }` shape; the
 *    raw `secretCipher` column is internal-only.
 */
@Entity('storage_providers')
export class StorageProvider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({
    type: 'enum',
    enum: StorageProviderKind,
    default: StorageProviderKind.S3_COMPATIBLE,
  })
  kind: StorageProviderKind;

  @Column({ type: 'varchar', length: 128 })
  displayName: string;

  @Column({ type: 'varchar', length: 512 })
  endpoint: string;

  @Column({ type: 'varchar', length: 64 })
  region: string;

  @Column({ type: 'varchar', length: 128 })
  bucket: string;

  // Access key IDs are public-ish (they identify, not authenticate).
  // Stored plaintext so admin UI can show them without a decrypt cycle.
  @Column({ type: 'varchar', length: 256 })
  accessKeyId: string;

  @Column({ type: 'bytea' })
  secretCipher: Buffer;

  @Column({ type: 'bytea' })
  secretNonce: Buffer;

  @Column({ type: 'bytea' })
  secretTag: Buffer;

  @Column({ type: 'smallint', default: 1 })
  keyVersion: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
