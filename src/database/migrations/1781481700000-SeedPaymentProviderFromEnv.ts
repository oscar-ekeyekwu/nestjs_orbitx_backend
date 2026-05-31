import { MigrationInterface, QueryRunner } from 'typeorm';
import { encryptSecret, loadStorageKek } from '../../storage/crypto.util';

/**
 * PAY-1 — bootstrap seed.
 *
 * Reads `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, and
 * `PAYSTACK_BASE_URL` from the environment, encrypts the secret key
 * with the storage KEK, and inserts a single row into
 * `payment_providers`. Points `system_configs['payment.activeProviderId']`
 * at it and writes a `bootstrap_seed` audit row.
 *
 * Idempotent — re-running is a no-op if any payment_providers row
 * already exists.
 *
 * Greenfield deploys with no legacy Paystack credentials can leave
 * `PAYSTACK_SECRET_KEY` blank — the migration logs a hint and skips
 * the seed. An admin creates the first provider via the admin UI
 * (/settings/payment-providers) when they have the keys.
 */
export class SeedPaymentProviderFromEnv1781481700000
  implements MigrationInterface
{
  name = 'SeedPaymentProviderFromEnv1781481700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing = (await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM "payment_providers"`,
    )) as { count: string }[];
    if (existing[0] && Number(existing[0].count) > 0) return;

    const secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
    const publicKey = process.env.PAYSTACK_PUBLIC_KEY ?? null;
    const baseUrl = process.env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co';

    if (!secretKey) {
      console.log(
        '[PAY-1] PAYSTACK_SECRET_KEY not set — skipping bootstrap seed. ' +
          'Create the first payment provider via the admin UI ' +
          '(/settings/payment-providers) before any order pays out.',
      );
      return;
    }

    const kek = loadStorageKek();
    const encrypted = encryptSecret(secretKey, kek);

    const inserted = (await queryRunner.query(
      `INSERT INTO "payment_providers" (
         "slug",
         "kind",
         "displayName",
         "baseUrl",
         "publicKey",
         "secretCipher",
         "secretNonce",
         "secretTag",
         "keyVersion",
         "enabled"
       ) VALUES (
         'paystack-main',
         'paystack',
         'Paystack (bootstrap)',
         $1, $2, $3, $4, $5, $6, true
       )
       RETURNING "id"`,
      [
        baseUrl,
        publicKey,
        encrypted.cipher,
        encrypted.nonce,
        encrypted.tag,
        encrypted.keyVersion,
      ],
    )) as { id: string }[];
    const providerId = inserted[0].id;

    await queryRunner.query(
      `INSERT INTO "system_configs" ("key", "value", "description", "dataType")
       VALUES (
         'payment.activeProviderId',
         $1,
         'PAY-1 — id of the payment_providers row PaymentService routes through.',
         'string'
       )
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      [providerId],
    );

    await queryRunner.query(
      `INSERT INTO "approval_decisions" (
         "targetType", "targetId", "action", "reviewerId", "reason"
       ) VALUES (
         'payment_provider',
         $1,
         'bootstrap_seed',
         NULL,
         $2
       )`,
      [
        providerId,
        `Seeded from PAYSTACK_* env vars (baseUrl=${baseUrl}). Plaintext secret never persisted.`,
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "approval_decisions"
       WHERE "targetType" = 'payment_provider' AND "action" = 'bootstrap_seed'`,
    );
    await queryRunner.query(
      `DELETE FROM "system_configs" WHERE "key" = 'payment.activeProviderId'`,
    );
    await queryRunner.query(
      `DELETE FROM "payment_providers" WHERE "slug" = 'paystack-main'`,
    );
  }
}
