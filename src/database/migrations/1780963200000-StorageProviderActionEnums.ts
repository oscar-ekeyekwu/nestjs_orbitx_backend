import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * STG-2 — extend `approval_decisions_action_enum` with the CRUD verbs
 * needed for the storage-provider admin audit log. Postgres requires
 * these new values to be added in a separate transaction from any row
 * that uses them, hence a dedicated migration.
 */
export class StorageProviderActionEnums1780963200000
  implements MigrationInterface
{
  name = 'StorageProviderActionEnums1780963200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_action_enum"
      ADD VALUE IF NOT EXISTS 'create'
    `);
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_action_enum"
      ADD VALUE IF NOT EXISTS 'update'
    `);
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_action_enum"
      ADD VALUE IF NOT EXISTS 'delete'
    `);
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_action_enum"
      ADD VALUE IF NOT EXISTS 'activate'
    `);
  }

  public async down(): Promise<void> {
    // Postgres does not support removing values from an enum. Leaving
    // the four values in place is safe — no other table references them.
  }
}
