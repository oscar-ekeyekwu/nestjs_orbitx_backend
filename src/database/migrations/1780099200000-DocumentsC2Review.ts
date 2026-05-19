import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C2 — extend the `documents` table to support admin review.
 *
 *   1. Add three new enum values to documents_type_enum:
 *        gov_id        — generic government-issued ID (passport, voter card)
 *        director_id   — company director's personal ID
 *        selfie        — face-match photo
 *
 *   2. Add review-trail columns (all nullable, populated when an admin
 *      approves/rejects in C5):
 *        reviewedAt        TIMESTAMP
 *        reviewedBy        uuid → users(id)
 *        rejectionReason   text
 *
 * Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction
 * provided the new value isn't used in the same transaction. We're
 * only adding the values here (no rows seeded yet), so the default
 * TypeORM migration transaction is fine.
 */
export class DocumentsC2Review1780099200000 implements MigrationInterface {
  name = 'DocumentsC2Review1780099200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'gov_id'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'director_id'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."documents_type_enum" ADD VALUE IF NOT EXISTS 'selfie'`,
    );

    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD COLUMN "reviewedAt" TIMESTAMP,
        ADD COLUMN "reviewedBy" uuid,
        ADD COLUMN "rejectionReason" text
    `);
    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD CONSTRAINT "FK_documents_reviewedBy"
        FOREIGN KEY ("reviewedBy")
        REFERENCES "users"("id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_reviewedBy" ON "documents" ("reviewedBy")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_documents_reviewedBy"`);
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "FK_documents_reviewedBy"`,
    );
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP COLUMN IF EXISTS "reviewedAt",
        DROP COLUMN IF EXISTS "reviewedBy",
        DROP COLUMN IF EXISTS "rejectionReason"
    `);
    // Postgres does NOT support removing enum values without rebuilding
    // the type, and the C5 review flow will start writing rows with
    // these values almost immediately. Leaving the enum extensions in
    // place on rollback is the pragmatic call — re-applying up() is a
    // no-op thanks to IF NOT EXISTS.
  }
}
