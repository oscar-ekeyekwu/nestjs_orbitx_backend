import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-order platform charge model.
 *
 *   - Adds `orders.platformCharge` (decimal(10,2) nullable). Captured at
 *     order-create time from the DRIVER_CHARGE_* config so retroactive
 *     config changes never rewrite historical holds.
 *   - Seeds four system_configs knobs:
 *       DRIVER_CHARGE_MODE        ('flat' | 'percentage'; default 'flat')
 *       DRIVER_CHARGE_FLAT        (Naira flat charge; default 200)
 *       DRIVER_CHARGE_PERCENTAGE  (0–100 of order price; default 10)
 *       DRIVER_CHARGE_CAP         (Naira cap for percentage; 0 = no cap)
 *
 * Customers pay the driver cash directly and the driver keeps it; the
 * platform instead holds this charge from the driver's prepaid wallet
 * when they accept the order. A driver whose balance is below an order's
 * charge cannot see or accept it.
 */
export class DriverChargeAndPlatformCharge1781827200000
  implements MigrationInterface
{
  name = 'DriverChargeAndPlatformCharge1781827200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "platformCharge" numeric(10,2) NULL`,
    );

    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "description", "dataType")
      VALUES
        ('DRIVER_CHARGE_MODE', 'flat',
         'How the per-order platform charge is computed: ''flat'' (fixed Naira from DRIVER_CHARGE_FLAT) or ''percentage'' (DRIVER_CHARGE_PERCENTAGE of the order price, capped by DRIVER_CHARGE_CAP). The charge is held from the driver''s prepaid wallet on acceptance.',
         'string'),
        ('DRIVER_CHARGE_FLAT', '200',
         'Flat per-order charge (Naira) held from the driver''s wallet on acceptance when DRIVER_CHARGE_MODE=''flat''.',
         'number'),
        ('DRIVER_CHARGE_PERCENTAGE', '10',
         'Per-order charge as a percentage (0–100) of the order price when DRIVER_CHARGE_MODE=''percentage''. Capped by DRIVER_CHARGE_CAP.',
         'number'),
        ('DRIVER_CHARGE_CAP', '0',
         'Maximum per-order charge (Naira) when DRIVER_CHARGE_MODE=''percentage''. 0 disables the cap.',
         'number')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "system_configs" WHERE "key" IN ('DRIVER_CHARGE_MODE', 'DRIVER_CHARGE_FLAT', 'DRIVER_CHARGE_PERCENTAGE', 'DRIVER_CHARGE_CAP')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "platformCharge"`,
    );
  }
}
