import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * STG-5 — post-migration verify pass + explicit source-delete bookkeeping.
 *
 * Adds:
 *  - storage_migration_verifications: one row per verify pass. Holds
 *    counters for matches vs gaps and an own status enum.
 *  - storage_migration_deletions: one row per document touched by the
 *    source-delete action. Records whether the source object was
 *    deleted, skipped because the destination copy was missing, or
 *    failed entirely.
 *  - storage_migrations.sourceDeletedAt: stamped on completion of the
 *    source-delete action so the UI / audit can show that step is done.
 */
export class StorageVerifyAndDelete1781136000000 implements MigrationInterface {
  name = 'StorageVerifyAndDelete1781136000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "storage_migration_verifications_status_enum" AS ENUM (
        'running', 'completed', 'completed_with_gaps'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_migration_verifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "migrationId" uuid NOT NULL,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "status" "storage_migration_verifications_status_enum" NOT NULL DEFAULT 'running',
        "verifiedCount" integer NOT NULL DEFAULT 0,
        "missingAtDestination" integer NOT NULL DEFAULT 0,
        "totalChecked" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_migration_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_migration_verifications_migration"
          FOREIGN KEY ("migrationId") REFERENCES "storage_migrations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_storage_migration_verifications_migration"
      ON "storage_migration_verifications" ("migrationId")
    `);

    await queryRunner.query(`
      CREATE TYPE "storage_migration_deletions_status_enum" AS ENUM (
        'deleted', 'skipped_missing_at_destination', 'failed'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_migration_deletions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "migrationId" uuid NOT NULL,
        "documentId" uuid NOT NULL,
        "status" "storage_migration_deletions_status_enum" NOT NULL,
        "errorMessage" text,
        "deletedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_migration_deletions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_migration_deletions_migration"
          FOREIGN KEY ("migrationId") REFERENCES "storage_migrations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_storage_migration_deletions_migration"
      ON "storage_migration_deletions" ("migrationId")
    `);

    await queryRunner.query(`
      ALTER TABLE "storage_migrations"
      ADD COLUMN IF NOT EXISTS "sourceDeletedAt" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "storage_migrations" DROP COLUMN IF EXISTS "sourceDeletedAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_storage_migration_deletions_migration"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "storage_migration_deletions"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "storage_migration_deletions_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_storage_migration_verifications_migration"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "storage_migration_verifications"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "storage_migration_verifications_status_enum"`,
    );
  }
}
