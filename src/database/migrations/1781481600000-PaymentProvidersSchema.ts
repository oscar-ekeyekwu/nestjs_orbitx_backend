import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PAY-1 — pluggable payment-gateway providers, schema.
 *
 * Mirrors the STG-1 `storage_providers` pattern:
 *   - one row per gateway integration (paystack-main,
 *     flutterwave-staging, etc.).
 *   - secret keys are AES-256-GCM encrypted with the same `STORAGE_KEK`
 *     the storage providers use. Public keys are plaintext because
 *     that's how every gateway distributes them.
 *
 * Schema only. The bootstrap seed (env → row) lives in the next
 * migration so Postgres can use the new `payment_provider` /
 * `bootstrap_seed` enum values without a same-transaction conflict.
 */
export class PaymentProvidersSchema1781481600000 implements MigrationInterface {
  name = 'PaymentProvidersSchema1781481600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payment_providers" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" varchar(64) UNIQUE NOT NULL,
        "kind" varchar(32) NOT NULL,
        "displayName" varchar(128) NOT NULL,
        "baseUrl" varchar(256) NOT NULL,
        "publicKey" varchar(256),
        "secretCipher" bytea NOT NULL,
        "secretNonce" bytea NOT NULL,
        "secretTag" bytea NOT NULL,
        "webhookSecretCipher" bytea,
        "webhookSecretNonce" bytea,
        "webhookSecretTag" bytea,
        "keyVersion" int NOT NULL DEFAULT 1,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    // Audit enum extensions. Idempotent + non-failing if the values
    // already exist (PG 12+ `ADD VALUE IF NOT EXISTS`). bootstrap_seed
    // was already added by STG-1's schema migration, so we just need
    // the new target type.
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_targettype_enum"
      ADD VALUE IF NOT EXISTS 'payment_provider'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_providers"`);
    // Postgres can't remove enum values; the down-migration leaves
    // 'payment_provider' in the enum. Safe — nothing else references it.
  }
}
