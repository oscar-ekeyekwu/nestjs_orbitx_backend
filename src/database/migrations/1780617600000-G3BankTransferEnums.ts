import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G3 — extends two existing enums to support the bank-transfer
 * reconcile flow:
 *
 *  - `order_payment_status_enum` gains `pending_transfer` so the
 *    order can sit in a wait-for-funds state before the admin marks
 *    the deposit reconciled.
 *  - `approval_decisions.targetType` gains `order` so the manual
 *    reconcile leaves an audit row of the same shape used for driver
 *    / vehicle / company approvals (DR-B4).
 *
 * Postgres ALTER TYPE ADD VALUE is non-transactional and idempotent
 * via IF NOT EXISTS — safe to re-run.
 */
export class G3BankTransferEnums1780617600000 implements MigrationInterface {
  name = 'G3BankTransferEnums1780617600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "order_payment_status_enum" ADD VALUE IF NOT EXISTS 'pending_transfer'
    `);
    await queryRunner.query(`
      ALTER TYPE "approval_decisions_targettype_enum" ADD VALUE IF NOT EXISTS 'order'
    `);
  }

  public async down(): Promise<void> {
    // Postgres does not support DROP VALUE on an enum. The down path
    // for this migration is intentionally a no-op; the only real
    // recovery is a manual data migration if the enum needs to be
    // narrowed in a future revision.
  }
}
