import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G4 — weekly payout records for drivers + company owners.
 *
 * One row per (recipient, periodStart) — enforced by a unique index so
 * a re-run of the Monday cron is idempotent. status carries the row
 * through the lifecycle:
 *
 *   pending       → cron just minted the row; dispatch hasn't run yet.
 *   processing    → Paystack transfer is in flight.
 *   paid          → wallet debited, transactions row inserted.
 *   pending_manual → recipient has no Paystack subaccount on file; an
 *                    admin must mark this paid from the disbursement page.
 *   failed        → Paystack rejected the transfer; admin reconcile.
 *
 * `method` records how the payout was settled (auto vs manual) and
 * `paystackTransferCode` / `manualReceiptReference` carry the matching
 * proof of disbursement.
 */
export class Payouts1780704000000 implements MigrationInterface {
  name = 'Payouts1780704000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // G4 — nullable users.paystackRecipientCode for the auto-transfer
    // lookup. v1 has no onboarding UI; admin populates manually.
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "paystackRecipientCode" varchar(64)
    `);

    await queryRunner.query(`
      CREATE TYPE "payout_status_enum" AS ENUM (
        'pending', 'processing', 'paid', 'pending_manual', 'failed'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "payout_method_enum" AS ENUM ('auto', 'manual')
    `);
    await queryRunner.query(`
      CREATE TABLE "payouts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "recipientUserId" uuid NOT NULL,
        "walletId" uuid NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "status" "payout_status_enum" NOT NULL DEFAULT 'pending',
        "method" "payout_method_enum",
        "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
        "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
        "paystackTransferCode" varchar(64),
        "manualReceiptReference" varchar(128),
        "completedBy" uuid,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "failureReason" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payouts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payouts_recipient"
          FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_payouts_wallet"
          FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_payouts_completed_by"
          FOREIGN KEY ("completedBy") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "UQ_payouts_recipient_period"
          UNIQUE ("recipientUserId", "periodStart")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_payouts_status" ON "payouts" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_payouts_recipient" ON "payouts" ("recipientUserId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payouts_recipient"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payouts_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payouts"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payout_method_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payout_status_enum"`);
  }
}
