import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `isPhoneVerified` column to `users`.
 *
 * The User entity already declared this field (with @Column default false),
 * but it was never included in the InitialMigration. Any query that SELECTs
 * the column — including the seed:admin script and any User.findOne with
 * default columns — fails with "column does not exist" against any database
 * that was migrated from the InitialMigration only. The prior production
 * deploy workflow's `|| true` masked the seed failure, so this drift went
 * unnoticed. This migration brings the schema in sync with the entity.
 *
 * Uses ADD COLUMN IF NOT EXISTS so it's safe to run against a database
 * where someone has already added the column manually.
 */
export class AddIsPhoneVerifiedToUsers1778735999000
  implements MigrationInterface
{
  name = 'AddIsPhoneVerifiedToUsers1778735999000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isPhoneVerified" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "isPhoneVerified"`,
    );
  }
}
