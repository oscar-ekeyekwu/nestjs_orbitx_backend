import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DR-NEW — refresh the driver KYC + vehicle compliance document catalog
 * against the v1 spec:
 *
 *   1. Driver ID coverage. NIN + driver's license + the umbrella
 *      `gov_id` already exist; add explicit `passport` and
 *      `voters_card` so the admin allowlist can include them by name
 *      (the customer-facing label set lives in the new
 *      `ALLOWED_DRIVER_ID_TYPES` system_config, seeded below).
 *
 *   2. Vehicle docs. The spec separates the registration certificate
 *      (already covered by `vehicle_registration`) from the annual
 *      license / road-tax certificate (`vehicle_license` — new), and
 *      promotes the vehicle photo from a single `vehicle.photoUrl`
 *      column to a full Document row (`vehicle_photo`) so it goes
 *      through review like every other compliance artefact.
 *
 *   3. Driver BVN. PII-grade — three new columns mirror the
 *      storage-provider secret pattern (cipher / nonce / tag +
 *      keyVersion). Plaintext never touches the database; admins see
 *      a masked value and the customer mobile only ever writes it.
 *
 *   4. ALLOWED_DRIVER_ID_TYPES system_config. JSON array of the
 *      DocumentType slugs the customer mobile is allowed to offer in
 *      its ID picker; tune at any time from the admin Settings page.
 *
 * Postgres 12+ allows ALTER TYPE ADD VALUE inside a transaction
 * provided the new value isn't used in the same transaction. We add
 * the values here only — no rows reference them yet.
 */
export class DriverIdSpecRefresh1781740800000 implements MigrationInterface {
  name = 'DriverIdSpecRefresh1781740800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'passport'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'voters_card'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'vehicle_license'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'vehicle_photo'`,
    );

    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "bvnCipher" bytea,
        ADD COLUMN IF NOT EXISTS "bvnNonce" bytea,
        ADD COLUMN IF NOT EXISTS "bvnTag" bytea,
        ADD COLUMN IF NOT EXISTS "bvnKeyVersion" smallint,
        ADD COLUMN IF NOT EXISTS "bvnLast4" varchar(4),
        ADD COLUMN IF NOT EXISTS "bvnUpdatedAt" timestamp with time zone
    `);

    await queryRunner.query(
      `INSERT INTO "system_configs" ("key", "value", "description", "dataType")
       VALUES (
         'ALLOWED_DRIVER_ID_TYPES',
         $1,
         'JSON array of DocumentType slugs the customer mobile may offer in its driver ID picker. Admin-tunable from Settings → ID Document Types.',
         'json'
       )
       ON CONFLICT ("key") DO NOTHING`,
      [JSON.stringify(['nin', 'drivers_license', 'passport', 'voters_card'])],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "system_configs" WHERE "key" = 'ALLOWED_DRIVER_ID_TYPES'`,
    );
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "bvnUpdatedAt",
        DROP COLUMN IF EXISTS "bvnLast4",
        DROP COLUMN IF EXISTS "bvnKeyVersion",
        DROP COLUMN IF EXISTS "bvnTag",
        DROP COLUMN IF EXISTS "bvnNonce",
        DROP COLUMN IF EXISTS "bvnCipher"
    `);
    // Postgres does NOT support removing enum values. The added values
    // remain orphaned in documents_type_enum after a down-migration —
    // safe (no rows reference them) but not strictly reversible.
  }
}
