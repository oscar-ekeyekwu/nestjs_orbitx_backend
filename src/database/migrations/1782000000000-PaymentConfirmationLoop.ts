import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 — close the offline bank-transfer payment loop.
 *
 *   1. Adds nullable bank account fields to driver_profiles so
 *      customers can see "transfer to GTBank 0123456789 — Tunde
 *      Bello" on their tracking screen.
 *   2. Adds CUSTOMER_MARKED_PAID to order_payment_status_enum, the
 *      intermediate state between "transfer started" and "driver
 *      confirmed receipt".
 *   3. Adds customerMarkedPaidAt + paymentConfirmedAt timestamps to
 *      orders for ops queries ("how long do drivers take to
 *      confirm receipt?").
 */
export class PaymentConfirmationLoop1782000000000
  implements MigrationInterface
{
  name = 'PaymentConfirmationLoop1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add the new enum value. Postgres's ALTER TYPE ADD VALUE is
    // additive and cheap; old enum casts continue to work.
    await queryRunner.query(`
      ALTER TYPE "order_payment_status_enum"
        ADD VALUE IF NOT EXISTS 'customer_marked_paid'
    `);

    // Driver bank account fields. Nullable so pre-Phase-3 drivers
    // can keep using the platform; the customer UI falls back to
    // the platform bank account when the driver's are blank.
    await queryRunner.query(`
      ALTER TABLE "driver_profiles"
        ADD COLUMN IF NOT EXISTS "bankName" varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS "bankAccountName" varchar(120) NULL,
        ADD COLUMN IF NOT EXISTS "bankAccountNumber" varchar(20) NULL
    `);

    // Order-level timestamps for the two new transitions. Both
    // nullable — only populated once the corresponding action fires.
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "customerMarkedPaidAt" timestamp NULL,
        ADD COLUMN IF NOT EXISTS "paymentConfirmedAt" timestamp NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
        DROP COLUMN IF EXISTS "paymentConfirmedAt",
        DROP COLUMN IF EXISTS "customerMarkedPaidAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "driver_profiles"
        DROP COLUMN IF EXISTS "bankAccountNumber",
        DROP COLUMN IF EXISTS "bankAccountName",
        DROP COLUMN IF EXISTS "bankName"
    `);
    // The enum value cannot be dropped without recreating the enum
    // — skipped in down() to keep the rollback safe. Orders already
    // in customer_marked_paid would corrupt on drop.
  }
}
