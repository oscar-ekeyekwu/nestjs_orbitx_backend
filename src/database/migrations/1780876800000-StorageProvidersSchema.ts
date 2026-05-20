import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * STG-1 — schema for pluggable storage providers.
 *
 * 1. Create the `storage_providers_kind_enum` + `storage_providers` table.
 *    Credentials are stored as bytea (AES-256-GCM ciphertext) — encryption
 *    is performed in the seed migration (1780876900000) which has the
 *    plaintext SPACES_* env vars in scope.
 * 2. Add `documents.storage_provider_id` (nullable for the bootstrap
 *    transition window). The seed migration backfills + NOT-NULLs in one
 *    transaction.
 * 3. ALTER TYPE both approval enums to accept the new audit shape. PG
 *    requires this in a separate migration from any row-insert that uses
 *    the new value, because newly-added enum values cannot be referenced
 *    in the same transaction they were created in.
 */
export class StorageProvidersSchema1780876800000 implements MigrationInterface {
  name = 'StorageProvidersSchema1780876800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "storage_providers_kind_enum" AS ENUM ('s3_compatible')
    `);

    await queryRunner.query(`
      CREATE TABLE "storage_providers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" varchar(64) NOT NULL,
        "kind" "storage_providers_kind_enum" NOT NULL DEFAULT 's3_compatible',
        "displayName" varchar(128) NOT NULL,
        "endpoint" varchar(512) NOT NULL,
        "region" varchar(64) NOT NULL,
        "bucket" varchar(128) NOT NULL,
        "accessKeyId" varchar(256) NOT NULL,
        "secretCipher" bytea NOT NULL,
        "secretNonce" bytea NOT NULL,
        "secretTag" bytea NOT NULL,
        "keyVersion" smallint NOT NULL DEFAULT 1,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdBy" uuid,
        "updatedBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_providers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_storage_providers_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN IF NOT EXISTS "storageProviderId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD CONSTRAINT "FK_documents_storage_provider"
      FOREIGN KEY ("storageProviderId")
      REFERENCES "storage_providers"("id")
      ON DELETE RESTRICT
      ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_documents_storageProviderId"
      ON "documents" ("storageProviderId")
    `);

    // Audit enum extensions. Idempotent + non-failing if the values
    // already exist (PG 12+ `ADD VALUE IF NOT EXISTS`).
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_targettype_enum"
      ADD VALUE IF NOT EXISTS 'storage_provider'
    `);
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_action_enum"
      ADD VALUE IF NOT EXISTS 'bootstrap_seed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres does not support removing values from an enum; the
    // down-migration leaves the two added values in place. That is safe
    // — the enum simply admits an extra value that nothing references.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_documents_storageProviderId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "FK_documents_storage_provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "storageProviderId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_providers"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "storage_providers_kind_enum"`,
    );
  }
}
