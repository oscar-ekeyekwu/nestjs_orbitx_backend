import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * J4 — three observability columns on `orders` so the matching-engine
 * dashboard can answer:
 *   - eligibleDriversAtBroadcast: how big was the pool?
 *   - timeToFirstAcceptMs: latency from create → accept
 *   - winningDriverDistanceKm: how far did the winner travel?
 *
 * All nullable — pre-J4 orders simply read as `null`. The admin metrics
 * endpoint filters them out of its averages.
 */
export class OrderMatchMetrics1781222400000 implements MigrationInterface {
  name = 'OrderMatchMetrics1781222400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "eligibleDriversAtBroadcast" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "timeToFirstAcceptMs" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "winningDriverDistanceKm" numeric(10,3)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "winningDriverDistanceKm"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "timeToFirstAcceptMs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "eligibleDriversAtBroadcast"`,
    );
  }
}
