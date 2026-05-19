import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D1 — allow `approval_decisions.reviewerId` to be NULL for system
 * driven transitions (cron-flipped suspensions, auto-pending on
 * setup completion). NULL is the documented "system" sentinel; the
 * admin paths still populate reviewerId as before.
 *
 * The FK to users(id) stays in place (NULL is permitted by the
 * ON DELETE NO ACTION reference). Down-migration restores NOT NULL
 * but only succeeds if no system rows exist yet (best-effort).
 */
export class NullableReviewerId1780185600000 implements MigrationInterface {
  name = 'NullableReviewerId1780185600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "approval_decisions" ALTER COLUMN "reviewerId" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort revert. Fails if any system rows have been written;
    // that's the intentional safety net (don't silently delete them).
    await queryRunner.query(
      `ALTER TABLE "approval_decisions" ALTER COLUMN "reviewerId" SET NOT NULL`,
    );
  }
}
