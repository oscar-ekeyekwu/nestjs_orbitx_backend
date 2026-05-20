import { MigrationInterface, QueryRunner } from 'typeorm';
import { encryptSecret, loadStorageKek } from '../../storage/crypto.util';

/**
 * STG-1 — bootstrap seed.
 *
 * Reads the legacy `SPACES_*` env vars, encrypts the secret access key
 * with the `STORAGE_KEK` KEK, inserts a single row into `storage_providers`,
 * points `system_configs['storage.activeProviderId']` at it, backfills
 * every existing `documents.storage_provider_id`, NOT-NULLs the column,
 * and writes a `bootstrap_seed` audit row. All inside one transaction.
 *
 * Idempotent — re-running the migration is a no-op if a row already
 * exists (which it will, post-first-run).
 *
 * After this migration runs, `SPACES_*` env vars are no longer read by
 * any code path outside the migration itself. The `storage_providers`
 * row is the source of truth.
 */
export class SeedStorageProviderFromEnv1780876900000
  implements MigrationInterface
{
  name = 'SeedStorageProviderFromEnv1780876900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing = (await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM "storage_providers"`,
    )) as { count: string }[];
    if (existing[0] && Number(existing[0].count) > 0) {
      // Already seeded — keep going to NOT-NULL the documents column
      // (idempotent) but skip the insert + audit.
      await this.ensureDocumentsNotNull(queryRunner);
      return;
    }

    const endpoint =
      process.env.SPACES_ENDPOINT ?? 'https://nyc3.digitaloceanspaces.com';
    const region = process.env.SPACES_REGION ?? 'nyc3';
    const bucket = process.env.SPACES_BUCKET ?? 'orbit-kyc-v1';
    const accessKeyId = process.env.SPACES_KEY ?? '';
    const secretAccessKey = process.env.SPACES_SECRET ?? '';

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'STG-1 bootstrap seed requires SPACES_KEY + SPACES_SECRET to be set so the existing DigitalOcean credentials can be migrated into storage_providers. Set them in your environment (or in CI secrets) before running migrations. After this migration runs once, the env vars are no longer consulted.',
      );
    }

    const kek = loadStorageKek();
    const encrypted = encryptSecret(secretAccessKey, kek);

    const inserted = (await queryRunner.query(
      `INSERT INTO "storage_providers" (
         "slug",
         "kind",
         "displayName",
         "endpoint",
         "region",
         "bucket",
         "accessKeyId",
         "secretCipher",
         "secretNonce",
         "secretTag",
         "keyVersion",
         "enabled"
       ) VALUES (
         'spaces-default',
         's3_compatible',
         'DigitalOcean Spaces (bootstrap)',
         $1, $2, $3, $4, $5, $6, $7, $8, true
       )
       RETURNING "id"`,
      [
        endpoint,
        region,
        bucket,
        accessKeyId,
        encrypted.cipher,
        encrypted.nonce,
        encrypted.tag,
        encrypted.keyVersion,
      ],
    )) as { id: string }[];
    const providerId = inserted[0].id;

    // system_configs already exists; set or upsert the active provider id.
    await queryRunner.query(
      `INSERT INTO "system_configs" ("key", "value", "description", "dataType")
       VALUES (
         'storage.activeProviderId',
         $1,
         'STG-1 — id of the storage_providers row that new uploads are routed to.',
         'string'
       )
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      [providerId],
    );

    await queryRunner.query(
      `UPDATE "documents" SET "storageProviderId" = $1
       WHERE "storageProviderId" IS NULL`,
      [providerId],
    );

    await this.ensureDocumentsNotNull(queryRunner);

    // Audit trail — system-actor (reviewerId NULL is the documented
    // sentinel per D1). The reason field carries enough provenance to
    // satisfy NDPR / LASAA trace requirements without echoing the
    // plaintext secret.
    await queryRunner.query(
      `INSERT INTO "approval_decisions" (
         "targetType", "targetId", "action", "reviewerId", "reason"
       ) VALUES (
         'storage_provider',
         $1,
         'bootstrap_seed',
         NULL,
         $2
       )`,
      [
        providerId,
        `Seeded from SPACES_* env vars (endpoint=${endpoint}, region=${region}, bucket=${bucket}). Plaintext secret never persisted.`,
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Roll back the NOT NULL + the seeded row. The schema migration
    // (1780876800000) tears down the rest.
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "storageProviderId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `DELETE FROM "system_configs" WHERE "key" = 'storage.activeProviderId'`,
    );
    await queryRunner.query(
      `DELETE FROM "approval_decisions"
       WHERE "targetType" = 'storage_provider' AND "action" = 'bootstrap_seed'`,
    );
    await queryRunner.query(
      `DELETE FROM "storage_providers" WHERE "slug" = 'spaces-default'`,
    );
  }

  private async ensureDocumentsNotNull(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const orphans = (await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM "documents" WHERE "storageProviderId" IS NULL`,
    )) as { count: string }[];
    if (orphans[0] && Number(orphans[0].count) > 0) {
      throw new Error(
        `STG-1 bootstrap: ${orphans[0].count} document(s) still have a NULL storageProviderId. Cannot apply NOT NULL. Investigate before retrying.`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "storageProviderId" SET NOT NULL`,
    );
  }
}
