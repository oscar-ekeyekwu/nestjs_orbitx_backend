import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 — payment-proof image. Customers can attach a screenshot
 * of their bank transfer at the customer_marked_paid step; the
 * driver sees it before tapping Confirm receipt. Required-vs-
 * optional is gated by the ORDER_PAYMENT_PROOF_REQUIRED system
 * config (admin-tunable).
 *
 *   orders.paymentProofUrl  : nullable text. URL into our storage
 *                              adapter. Stays null when the
 *                              customer didn't upload one.
 *   system_configs row      : ORDER_PAYMENT_PROOF_REQUIRED, default
 *                              'false'.
 */
export class PaymentProofUrl1782100000000 implements MigrationInterface {
  name = 'PaymentProofUrl1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "paymentProofUrl" text NULL
    `);

    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "description", "dataType")
      VALUES (
        'ORDER_PAYMENT_PROOF_REQUIRED',
        'false',
        'When true, customers must attach a proof image (screenshot of their bank transfer) before they can mark an order paid. When false the proof field is optional. Admins tune from Settings → Payment Proof.',
        'boolean'
      )
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "system_configs"
      WHERE "key" = 'ORDER_PAYMENT_PROOF_REQUIRED'
    `);
    await queryRunner.query(`
      ALTER TABLE "orders" DROP COLUMN IF EXISTS "paymentProofUrl"
    `);
  }
}
