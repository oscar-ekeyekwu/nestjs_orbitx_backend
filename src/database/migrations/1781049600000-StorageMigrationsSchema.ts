import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * STG-4 — cross-provider document migration tables.
 *
 * Two tables:
 *  - storage_migrations: one row per queued job, lifecycle status,
 *    progress counters, and the `queuedUntilCreatedAt` anchor so docs
 *    uploaded during a long-running migration are NOT re-copied.
 *  - storage_migration_failures: one row per failed document attempt
 *    chain, surfaced in the admin detail page.
 *
 * Extends `approval_decisions_targettype_enum` with `storage_migration`
 * and `approval_decisions_action_enum` with `pause` so the migration
 * worker's audit writes land in the existing ledger.
 */
export class StorageMigrationsSchema1781049600000
  implements MigrationInterface
{
  name = 'StorageMigrationsSchema1781049600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_targettype_enum"
      ADD VALUE IF NOT EXISTS 'storage_migration'
    `);
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_action_enum"
      ADD VALUE IF NOT EXISTS 'pause'
    `);

    await queryRunner.query(`
      CREATE TYPE "storage_migrations_status_enum" AS ENUM (
        'queued', 'running', 'paused', 'completed', 'completed_with_errors'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_migrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "fromProviderId" uuid NOT NULL,
        "toProviderId" uuid NOT NULL,
        "status" "storage_migrations_status_enum" NOT NULL DEFAULT 'queued',
        "dryRun" boolean NOT NULL DEFAULT false,
        "batchSize" integer NOT NULL DEFAULT 25,
        "since" TIMESTAMP WITH TIME ZONE,
        "queuedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "queuedUntilCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "totalDocuments" integer NOT NULL DEFAULT 0,
        "migratedCount" integer NOT NULL DEFAULT 0,
        "wouldMigrateCount" integer NOT NULL DEFAULT 0,
        "failedCount" integer NOT NULL DEFAULT 0,
        "skippedCount" integer NOT NULL DEFAULT 0,
        "lastDocumentId" uuid,
        "startedBy" uuid,
        "errorMessage" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_migrations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_migrations_from"
          FOREIGN KEY ("fromProviderId") REFERENCES "storage_providers"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_storage_migrations_to"
          FOREIGN KEY ("toProviderId") REFERENCES "storage_providers"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_storage_migrations_status"
      ON "storage_migrations" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE "storage_migration_failures" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "migrationId" uuid NOT NULL,
        "documentId" uuid NOT NULL,
        "errorMessage" text NOT NULL,
        "attempt" smallint NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_migration_failures" PRIMARY KEY ("id"),
        CONSTRAINT "FK_storage_migration_failures_migration"
          FOREIGN KEY ("migrationId") REFERENCES "storage_migrations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_storage_migration_failures_migration"
      ON "storage_migration_failures" ("migrationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_storage_migration_failures_migration"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "storage_migration_failures"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_storage_migrations_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_migrations"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "storage_migrations_status_enum"`,
    );
    // Enum values are kept in place; PG can't drop them and nothing
    // else references them after the table drops.
  }
}
