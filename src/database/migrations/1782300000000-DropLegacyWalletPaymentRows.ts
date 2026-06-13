import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sweep out wallet transaction rows that don't belong under the
 * agreed wallet model. Per the model, the driver's wallet ledger
 * only records:
 *
 *   - Funding (CREDIT)              — top-ups
 *   - Order completion charges (DEBIT)
 *   - Order insurance fees (DEBIT)
 *   - Withdrawals / payouts (DEBIT)
 *
 * The customer pays the driver DIRECTLY for the order (off-platform);
 * the order payment never enters the wallet. Earlier in the refactor
 * we still had a `processOrderPayment` path that credited the
 * driver's wallet at delivery, plus a brief experimental
 * `recordCashOrderCompletion` pair (CREDIT cash delivery earnings
 * + DEBIT cash settlement) that wrote balanced rows for the ledger
 * only. Both flows have since been removed, but the rows they
 * inserted remain in the database and continue to inflate the
 * driver's visible balance under the new view.
 *
 * This migration deletes those legacy rows so the ledger view
 * reflects the new model exactly. The driver's balance will drop by
 * the net of (Payment for order %) rows (the cash pair was balanced,
 * so no balance change there).
 *
 * Match by description pattern + the metadata flag we wrote, NOT by
 * orderId alone — legitimate completion charges and insurance fees
 * also carry orderIds and must stay.
 */
export class DropLegacyWalletPaymentRows1782300000000
  implements MigrationInterface
{
  name = 'DropLegacyWalletPaymentRows1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // processOrderPayment credits — net credit, deletion REDUCES
    // wallet balance by the sum of these rows per driver.
    await queryRunner.query(`
      DELETE FROM "transactions"
      WHERE "type" = 'credit'
        AND "description" LIKE 'Payment for order %'
    `);

    // recordCashOrderCompletion balanced pair — both rows go; net
    // zero impact on balance since they were equal-and-opposite.
    await queryRunner.query(`
      DELETE FROM "transactions"
      WHERE "description" LIKE 'Cash delivery earnings%'
         OR "description" LIKE 'Cash settlement%'
         OR ("metadata" ? 'cashKept' AND "metadata"->>'cashKept' = 'true')
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No-op: the deleted rows were created by code paths that no
    // longer exist. There's nothing meaningful to re-insert on
    // rollback — the rows would need to be reconstructed from
    // application-level data we don't store.
  }
}
