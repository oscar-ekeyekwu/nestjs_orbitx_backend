import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Insurance fee charged to the rider per completed delivery.
 *
 *   - Adds `orders.insuranceFee` (decimal(10,2) nullable). Captured at
 *     order-create time from system_configs so retroactive config
 *     changes never rewrite historical settlements.
 *   - Seeds two system_configs knobs (both default 0 = disabled):
 *     ORDER_INSURANCE_FEE_FIXED  (Naira flat per delivery)
 *     ORDER_INSURANCE_FEE_PERCENT (0–100; takes precedence when > 0)
 *
 * The fee is debited from the driver's wallet credit when the order
 * settles (cash collection / Paystack charge.success). The customer
 * pays the standard order price — insurance does NOT appear on their
 * receipt; it's a per-trip cost the rider bears, mirroring how taxis
 * and ride-share platforms model commercial driver insurance.
 */
export class OrderInsuranceFee1781654400000 implements MigrationInterface {
  name = 'OrderInsuranceFee1781654400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "insuranceFee" numeric(10,2) NULL`,
    );

    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "description", "dataType")
      VALUES
        ('ORDER_INSURANCE_FEE_FIXED', '0',
         'Fixed insurance fee (Naira) debited from the rider per delivery. Used when ORDER_INSURANCE_FEE_PERCENT is 0. Set both to 0 to disable insurance.',
         'number'),
        ('ORDER_INSURANCE_FEE_PERCENT', '0',
         'Insurance fee as a percentage (0–100) of the order price, debited from the rider per delivery. Takes precedence over the fixed fee when > 0.',
         'number')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "system_configs" WHERE "key" IN ('ORDER_INSURANCE_FEE_FIXED', 'ORDER_INSURANCE_FEE_PERCENT')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "insuranceFee"`,
    );
  }
}
