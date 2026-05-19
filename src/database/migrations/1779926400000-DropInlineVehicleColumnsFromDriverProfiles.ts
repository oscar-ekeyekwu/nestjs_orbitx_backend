import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B2 — Drop the inline vehicle columns from `driver_profiles`.
 *
 * `vehicleType`, `vehiclePlate`, and `licenseNumber` used to live on the
 * driver row. Architecture §1.1 splits those facts into the `vehicles`
 * + `documents` tables instead. The `vehicles` table (ARCH-2) carries
 * type / plate / color; the `documents` table will carry the
 * licence number under DocumentType.DRIVERS_LICENSE.
 *
 * Forward-only: we don't edit InitialV1Migration retroactively, even
 * pre-launch, so the migration log stays a faithful history of every
 * schema change. The baseline created the columns; this migration
 * removes them.
 */
export class DropInlineVehicleColumnsFromDriverProfiles1779926400000
  implements MigrationInterface
{
  name = 'DropInlineVehicleColumnsFromDriverProfiles1779926400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "driver_profiles" DROP COLUMN IF EXISTS "vehicleType"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_profiles" DROP COLUMN IF EXISTS "vehiclePlate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_profiles" DROP COLUMN IF EXISTS "licenseNumber"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "driver_profiles" ADD COLUMN "vehicleType" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_profiles" ADD COLUMN "vehiclePlate" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_profiles" ADD COLUMN "licenseNumber" character varying`,
    );
  }
}
