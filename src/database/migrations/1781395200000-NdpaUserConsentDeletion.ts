import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * I1 — NDPA 2023 data-subject-rights columns on `users`.
 *
 *   consentedAt          → timestamp when the user ticked the privacy
 *                          policy checkbox at registration. NULL means
 *                          we never captured explicit consent (legacy
 *                          rows pre-I1).
 *   deletionScheduledAt  → if non-null, the user has requested account
 *                          deletion and the 30-day grace window
 *                          expires at this time. The cron sweeps rows
 *                          whose grace has elapsed.
 *   pseudonymizedAt      → stamped after the cron runs; the canonical
 *                          identifiers (email / phone / first_name /
 *                          last_name) are scrambled but the user_id
 *                          is preserved so order history can survive
 *                          in anonymised form (DR-N3).
 */
export class NdpaUserConsentDeletion1781395200000
  implements MigrationInterface
{
  name = 'NdpaUserConsentDeletion1781395200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "consentedAt" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "deletionScheduledAt" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "pseudonymizedAt" TIMESTAMP WITH TIME ZONE
    `);
    // Index supports the cron sweep that fires `WHERE
    // deletionScheduledAt < now() - 30 days AND pseudonymizedAt IS NULL`.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_deletionScheduledAt"
      ON "users" ("deletionScheduledAt")
      WHERE "deletionScheduledAt" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_users_deletionScheduledAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "pseudonymizedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "deletionScheduledAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "consentedAt"`,
    );
  }
}
