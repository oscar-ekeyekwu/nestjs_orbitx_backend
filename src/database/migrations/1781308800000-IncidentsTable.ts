import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * I6 — driver SOS + incident workflow tables.
 *
 * One row per SOS event. Status enum tracks the operator workflow
 * from raise → ack → close. Outcome is captured as a free-text note
 * + a structured enum so the weekly compliance roll-up can count
 * each kind.
 */
export class IncidentsTable1781308800000 implements MigrationInterface {
  name = 'IncidentsTable1781308800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "incidents_status_enum" AS ENUM (
        'open', 'acknowledged', 'closed'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "incidents_outcome_enum" AS ENUM (
        'resolved', 'escalated_frsc', 'referred_insurance', 'false_alarm'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "incidents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "orderId" uuid NOT NULL,
        "driverId" uuid NOT NULL,
        "latitude" numeric(10,7),
        "longitude" numeric(10,7),
        "status" "incidents_status_enum" NOT NULL DEFAULT 'open',
        "outcome" "incidents_outcome_enum",
        "outcomeNote" text,
        "raisedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "acknowledgedAt" TIMESTAMP WITH TIME ZONE,
        "acknowledgedBy" uuid,
        "closedAt" TIMESTAMP WITH TIME ZONE,
        "closedBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_incidents_order"
          FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_incidents_driver"
          FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_incidents_status" ON "incidents" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_incidents_orderId" ON "incidents" ("orderId")
    `);

    // I6 — sticky flag on the customer-tracking screen. Nullable so
    // pre-I6 rows simply read as `false`.
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "incidentFlagged" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "incidentFlagged"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_incidents_orderId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_incidents_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "incidents"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "incidents_outcome_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "incidents_status_enum"`);
  }
}
