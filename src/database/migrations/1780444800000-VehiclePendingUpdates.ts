import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F2 — staging table for regulatory edits to already-approved vehicles.
 *
 * The contract: an owner submits a regulatory change (type / plate) on
 * an `approved` vehicle, the service inserts a row here instead of
 * mutating the live `vehicles` row, and an admin later approves or
 * rejects the proposed values.
 *
 * One pending row per vehicle is enforced with a partial unique index:
 * a vehicle may have at most one pending update at a time, but any
 * number of historical approved / rejected rows.
 */
export class VehiclePendingUpdates1780444800000 implements MigrationInterface {
  name = 'VehiclePendingUpdates1780444800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "vehicle_pending_update_status_enum" AS ENUM (
        'pending', 'approved', 'rejected'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "vehicle_pending_updates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "vehicleId" uuid NOT NULL,
        "proposedType" varchar(32),
        "proposedPlate" varchar(32),
        "submittedBy" uuid NOT NULL,
        "status" "vehicle_pending_update_status_enum" NOT NULL DEFAULT 'pending',
        "reviewedBy" uuid,
        "reviewedAt" TIMESTAMP WITH TIME ZONE,
        "reviewReason" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vehicle_pending_updates" PRIMARY KEY ("id"),
        CONSTRAINT "FK_vpu_vehicle"
          FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_vpu_submitted_by"
          FOREIGN KEY ("submittedBy") REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_vpu_reviewed_by"
          FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_vpu_vehicleId"
        ON "vehicle_pending_updates" ("vehicleId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_vpu_status"
        ON "vehicle_pending_updates" ("status")
    `);
    // Partial unique: at most one pending row per vehicle, but any
    // number of resolved rows can coexist (history).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_vpu_one_pending_per_vehicle"
        ON "vehicle_pending_updates" ("vehicleId")
        WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_vpu_one_pending_per_vehicle"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_vpu_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_vpu_vehicleId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vehicle_pending_updates"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "vehicle_pending_update_status_enum"`,
    );
  }
}
