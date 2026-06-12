import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the cached `wallets.balance` column in favour of a database
 * view that derives the balance from the `transactions` table — the
 * only source of truth under the ledger-driven wallet model.
 *
 * Before the column is dropped, any drift between the cached balance
 * and the ledger is reconciled with a single CREDIT / DEBIT row per
 * wallet so the view's computed balance equals the old cached value.
 * This keeps every existing driver whole through the cutover.
 *
 * The view exposes:
 *   wallet_balances.wallet_id : uuid (PK of wallets)
 *   wallet_balances.user_id   : uuid
 *   wallet_balances.balance   : numeric(12,2)  — sum(completed credits) − sum(completed debits)
 *
 * Reads go through the view (or a SUM query over transactions when a
 * row-level lock is needed inside a transaction). Writes only insert
 * Transaction rows; the view updates automatically.
 */
export class WalletBalanceView1782200000000 implements MigrationInterface {
  name = 'WalletBalanceView1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Reconcile cached balance ↔ ledger drift by writing a single
    //    opening-balance row per wallet that closes the gap. Skip
    //    wallets whose ledger already matches the cache.
    await queryRunner.query(`
      INSERT INTO "transactions" (
        "id", "walletId", "type", "amount", "commission",
        "balanceAfter", "status", "paymentMethod",
        "description", "metadata", "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        w_id,
        CASE WHEN diff > 0 THEN 'credit' ELSE 'debit' END,
        ABS(diff)::numeric(12,2),
        0,
        cached_balance,
        'completed',
        'wallet',
        'Opening balance reconciliation (wallet.balance column dropped; ledger view introduced)',
        ('{"type":"balance_column_migration_reconciliation"}')::jsonb,
        NOW(),
        NOW()
      FROM (
        SELECT
          w.id AS w_id,
          w.balance AS cached_balance,
          w.balance - COALESCE((
            SELECT
              COALESCE(SUM(CASE WHEN t.type = 'credit' AND t.status = 'completed' THEN t.amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN t.type = 'debit' AND t.status = 'completed' THEN t.amount ELSE 0 END), 0)
            FROM "transactions" t
            WHERE t."walletId" = w.id
          ), 0) AS diff
        FROM "wallets" w
      ) sub
      WHERE diff <> 0
    `);

    // 2. Drop the cached column. The reconcile cron + every read
    //    path moves to the view in the same code change.
    await queryRunner.query(`
      ALTER TABLE "wallets" DROP COLUMN IF EXISTS "balance"
    `);

    // 3. Create the view. LEFT JOIN so wallets with zero
    //    transactions still resolve to 0 rather than NULL.
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "wallet_balances" AS
      SELECT
        w."id"     AS "wallet_id",
        w."userId" AS "user_id",
        COALESCE(SUM(
          CASE
            WHEN t."type" = 'credit' AND t."status" = 'completed' THEN  t."amount"
            WHEN t."type" = 'debit'  AND t."status" = 'completed' THEN -t."amount"
            ELSE 0
          END
        ), 0)::numeric(12,2) AS "balance"
      FROM "wallets" w
      LEFT JOIN "transactions" t ON t."walletId" = w."id"
      GROUP BY w."id", w."userId"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS "wallet_balances"`);

    await queryRunner.query(`
      ALTER TABLE "wallets"
        ADD COLUMN IF NOT EXISTS "balance" numeric(12,2) NOT NULL DEFAULT 0
    `);

    // Backfill from the ledger so a roll-back doesn't lose balances.
    await queryRunner.query(`
      UPDATE "wallets" w
      SET "balance" = COALESCE(led.bal, 0)
      FROM (
        SELECT
          t."walletId" AS wid,
          COALESCE(SUM(CASE WHEN t.type='credit' AND t.status='completed' THEN t.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.type='debit' AND t.status='completed' THEN t.amount ELSE 0 END), 0)
          AS bal
        FROM "transactions" t
        GROUP BY t."walletId"
      ) led
      WHERE led.wid = w."id"
    `);

    // Sweep the reconciliation rows so re-applying the up()
    // migration is idempotent for development environments.
    await queryRunner.query(`
      DELETE FROM "transactions"
      WHERE "metadata" ->> 'type' = 'balance_column_migration_reconciliation'
    `);
  }
}
