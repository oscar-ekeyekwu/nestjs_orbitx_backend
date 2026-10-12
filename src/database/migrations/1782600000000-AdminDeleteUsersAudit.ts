import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin-initiated customer / driver deletion writes an audit row with
 * targetType = 'user' (the self-service NDPA path reused 'driver' for
 * every role, which mislabels customers in the ledger). Extends the
 * enum additively; Postgres cannot remove enum values, so `down` is a
 * no-op by design — an unused extra value is harmless.
 */
export class AdminDeleteUsersAudit1782600000000 implements MigrationInterface {
  name = 'AdminDeleteUsersAudit1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_targettype_enum"
      ADD VALUE IF NOT EXISTS 'user'
    `);
  }

  public async down(): Promise<void> {
    // Enum values cannot be dropped in Postgres; leaving 'user' in place
    // is safe.
  }
}
