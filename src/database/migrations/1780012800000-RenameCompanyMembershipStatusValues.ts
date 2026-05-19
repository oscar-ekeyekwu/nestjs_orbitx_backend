import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B4 — rename company_memberships.status enum values to match the
 * platform vocabulary published by the B4 AC.
 *
 *   ARCH-2 baseline : 'pending' | 'active'   | 'inactive'
 *   B4 final values : 'pending' | 'approved' | 'removed'
 *
 * 'active' was always semantically wrong here — the membership being
 * accepted doesn't make the driver active in the operational sense
 * (that's driver_profiles.verificationStatus). Renaming to 'approved'
 * mirrors the admin-driven approval pattern the rest of the platform
 * uses, and 'removed' is the soft-revoke verb every audit-friendly
 * lifecycle needs.
 *
 * Postgres 10+ supports ALTER TYPE ... RENAME VALUE which keeps every
 * existing row's bytes untouched — no row migration required.
 */
export class RenameCompanyMembershipStatusValues1780012800000
  implements MigrationInterface
{
  name = 'RenameCompanyMembershipStatusValues1780012800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."company_memberships_status_enum" RENAME VALUE 'active' TO 'approved'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."company_memberships_status_enum" RENAME VALUE 'inactive' TO 'removed'`,
    );
    // Default was 'pending' in the baseline and stays 'pending' here —
    // no ALTER COLUMN SET DEFAULT needed.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."company_memberships_status_enum" RENAME VALUE 'approved' TO 'active'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."company_memberships_status_enum" RENAME VALUE 'removed' TO 'inactive'`,
    );
  }
}
