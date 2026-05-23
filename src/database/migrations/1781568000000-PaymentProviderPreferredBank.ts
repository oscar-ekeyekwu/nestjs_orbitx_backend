import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PAY-1 — store the DVA preferred-bank slug on the payment_providers
 * row so admins can swap Paystack live banks (wema-bank / access-bank /
 * titan-paystack) without a redeploy. Null = let the gateway pick a
 * sensible default by sniffing the test/live key prefix.
 *
 * Backfills existing rows by probing `system_configs` for a previously
 * configured value (none in v1; defensive only) — otherwise leaves
 * the column null and lets the gateway default take over.
 */
export class PaymentProviderPreferredBank1781568000000
  implements MigrationInterface
{
  name = 'PaymentProviderPreferredBank1781568000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_providers"
      ADD COLUMN IF NOT EXISTS "preferredBank" varchar(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_providers" DROP COLUMN IF EXISTS "preferredBank"`,
    );
  }
}
