import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G5 — locks the commission percentage used to settle each transaction
 * at the time of completion. Storing the rate on the row (alongside the
 * absolute Naira `commission` value) makes future retroactive rate
 * changes idempotent at the audit layer — a recalculation against the
 * new rate would visibly contradict the historical row.
 *
 * Nullable so back-compat — pre-G5 transactions don't have a captured
 * rate; reads should treat null as "rate not recorded" rather than 0%.
 */
export class TransactionCommissionPct1780790400000
  implements MigrationInterface
{
  name = 'TransactionCommissionPct1780790400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions"
      ADD COLUMN IF NOT EXISTS "commissionPct" numeric(5,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP COLUMN IF EXISTS "commissionPct"`,
    );
  }
}
