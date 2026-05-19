import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G2 — adds payment_method + payment_status to orders so the platform
 * knows which channel (cash / paystack / transfer / wallet) the
 * customer chose at checkout and where the money currently sits.
 *
 * Existing rows backfill to `cash` / `pending_cash` since that's the
 * v0 implicit default — drivers were collecting cash on delivery
 * without an explicit flag. The matching ARCH-13 + G1 work tags new
 * Paystack orders explicitly.
 */
export class OrderPaymentColumns1780531200000 implements MigrationInterface {
  name = 'OrderPaymentColumns1780531200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "order_payment_status_enum" AS ENUM (
        'pending', 'pending_cash', 'completed', 'failed'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD COLUMN "paymentMethod" "transactions_paymentmethod_enum"
        NOT NULL DEFAULT 'cash'
    `);
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD COLUMN "paymentStatus" "order_payment_status_enum"
        NOT NULL DEFAULT 'pending_cash'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_orders_paymentStatus"
        ON "orders" ("paymentStatus")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_paymentStatus"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "paymentStatus"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "paymentMethod"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "order_payment_status_enum"`);
  }
}
