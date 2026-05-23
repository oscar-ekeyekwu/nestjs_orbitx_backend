import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentProviderKind {
  PAYSTACK = 'paystack',
  // Future kinds (FLUTTERWAVE, STRIPE, ...) land here; each gets a
  // concrete adapter implementing IPaymentGateway.
}

/**
 * PAY-1 — durable registry of credential-bearing payment gateway
 * providers. The `system_configs['payment.activeProviderId']` key names
 * which row PaymentService routes through; admins rotate credentials or
 * swap providers by writing to this table (no redeploy).
 *
 * Credentials encrypted at rest via the StorageCryptoService
 * (AES-256-GCM, KEK from `STORAGE_KEK` — same key the storage providers
 * use). `webhookSecret*` columns are nullable because some gateways
 * (including Paystack) re-use the main secret for webhook signature
 * verification.
 *
 * The plaintext keys are never persisted or logged. List/detail
 * responses serialise a masked shape (`••••••XXXX`); raw cipher columns
 * are internal-only.
 */
@Entity('payment_providers')
export class PaymentProvider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'varchar', length: 32 })
  kind: PaymentProviderKind;

  @Column({ type: 'varchar', length: 128 })
  displayName: string;

  @Column({ type: 'varchar', length: 256 })
  baseUrl: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  publicKey: string | null;

  // Gateway-specific routing hint. For Paystack this is the DVA
  // `preferred_bank` slug (`wema-bank`, `access-bank`, `titan-paystack`
  // on live; `test-bank` on test). Null lets the adapter pick a sensible
  // default by inspecting the secret key prefix.
  @Column({ type: 'varchar', length: 64, nullable: true })
  preferredBank: string | null;

  @Column({ type: 'bytea' })
  secretCipher: Buffer;

  @Column({ type: 'bytea' })
  secretNonce: Buffer;

  @Column({ type: 'bytea' })
  secretTag: Buffer;

  // Optional dedicated webhook signing secret. When null, the gateway
  // adapter falls back to the main secretKey for HMAC verification —
  // Paystack uses this pattern.
  @Column({ type: 'bytea', nullable: true })
  webhookSecretCipher: Buffer | null;

  @Column({ type: 'bytea', nullable: true })
  webhookSecretNonce: Buffer | null;

  @Column({ type: 'bytea', nullable: true })
  webhookSecretTag: Buffer | null;

  @Column({ type: 'int', default: 1 })
  keyVersion: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
