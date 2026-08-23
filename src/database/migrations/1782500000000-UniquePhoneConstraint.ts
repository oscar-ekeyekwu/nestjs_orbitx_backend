import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phone becomes a login identifier alongside email, so it needs the same
 * uniqueness guarantee. Postgres UNIQUE constraints treat NULLs as
 * distinct, so users with no phone on file are unaffected.
 *
 * `phone` was previously writable via PATCH /users/me with no uniqueness
 * check, so existing duplicates are possible. Null out every duplicate
 * except the oldest row before adding the constraint so the migration
 * can't fail on pre-existing data.
 */
export class UniquePhoneConstraint1782500000000
  implements MigrationInterface
{
  name = 'UniquePhoneConstraint1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users" u
      SET "phone" = NULL
      WHERE u."phone" IS NOT NULL
        AND u."id" <> (
          SELECT u2."id" FROM "users" u2
          WHERE u2."phone" = u."phone"
          ORDER BY u2."createdAt" ASC, u2."id" ASC
          LIMIT 1
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "UQ_users_phone" UNIQUE ("phone")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_phone"`,
    );
  }
}
