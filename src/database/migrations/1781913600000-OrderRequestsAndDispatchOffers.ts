import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 of the dispatch rewrite — replaces "create order, then
 * hope a driver accepts" with an explicit pre-order request +
 * driver-offer loop.
 *
 * Tables
 * ──────
 *
 *   order_requests
 *     One row per customer "Find driver" tap. Lifecycle:
 *       open → resolved (driver picked) | expired | cancelled
 *     Holds the quotedPrice, insuranceFee, platformCharge snapshots
 *     that the resolved Order inherits at acceptance time.
 *
 *   dispatch_offers
 *     A driver's response to an order request — either accepting
 *     the customer's quoted price (quote_accept) or proposing a
 *     different price (counter). Lifecycle:
 *       pending → accepted | rejected | expired | withdrawn
 *     A partial unique index enforces single-active-offer per
 *     driver: a driver with a pending offer cannot submit another
 *     until the first resolves.
 *
 * Order link
 * ──────────
 *
 *   orders.orderRequestId nullable uuid — populated only on orders
 *   created via the request flow; legacy orders stay NULL.
 *
 * Config knobs
 * ────────────
 *
 *   ORDER_REQUEST_TTL_SECONDS    (default 300 — 5 min)
 *   DISPATCH_OFFER_TTL_SECONDS   (default 60)
 *   ORDER_REQUEST_RADIUS_KM      (default 5; reuses
 *                                 ORDER_DELIVERY_RADIUS_KM semantics)
 */
export class OrderRequestsAndDispatchOffers1781913600000
  implements MigrationInterface
{
  name = 'OrderRequestsAndDispatchOffers1781913600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enums
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "order_request_status_enum" AS ENUM (
          'open', 'resolved', 'expired', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "dispatch_offer_type_enum" AS ENUM (
          'quote_accept', 'counter'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "dispatch_offer_status_enum" AS ENUM (
          'pending', 'accepted', 'rejected', 'expired', 'withdrawn'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // order_requests
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_requests" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "customerId" uuid NOT NULL REFERENCES "users"("id"),
        "status" "order_request_status_enum" NOT NULL DEFAULT 'open',
        "pickupLatitude" numeric(10,7) NOT NULL,
        "pickupLongitude" numeric(10,7) NOT NULL,
        "pickupAddress" varchar NOT NULL,
        "deliveryLatitude" numeric(10,7) NOT NULL,
        "deliveryLongitude" numeric(10,7) NOT NULL,
        "deliveryAddress" varchar NOT NULL,
        "recipientName" varchar NOT NULL,
        "recipientPhone" varchar NOT NULL,
        "packageDescription" varchar NOT NULL,
        "packageWeight" numeric(5,2) NULL,
        "packageSize" "orders_packagesize_enum" NOT NULL DEFAULT 'medium',
        "deliveryNotes" text NULL,
        "quotedPrice" numeric(10,2) NOT NULL,
        "insuranceFee" numeric(10,2) NULL,
        "platformCharge" numeric(10,2) NULL,
        "distanceKm" numeric(10,3) NULL,
        "expiresAt" timestamp NOT NULL,
        "resolvedOrderId" uuid NULL REFERENCES "orders"("id") ON DELETE SET NULL,
        "resolvedOfferId" uuid NULL,
        "eligibleDriversAtBroadcast" integer NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_order_requests_customer"
        ON "order_requests" ("customerId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_order_requests_status_expires"
        ON "order_requests" ("status", "expiresAt")
    `);

    // dispatch_offers
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dispatch_offers" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "requestId" uuid NOT NULL REFERENCES "order_requests"("id") ON DELETE CASCADE,
        "driverId" uuid NOT NULL REFERENCES "users"("id"),
        "type" "dispatch_offer_type_enum" NOT NULL,
        "status" "dispatch_offer_status_enum" NOT NULL DEFAULT 'pending',
        "price" numeric(10,2) NOT NULL,
        "etaSeconds" integer NOT NULL,
        "reason" text NULL,
        "offerExpiresAt" timestamp NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dispatch_offers_request"
        ON "dispatch_offers" ("requestId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dispatch_offers_driver"
        ON "dispatch_offers" ("driverId")
    `);
    // Partial unique index — a driver can have at most one PENDING
    // offer open across all requests. The constraint applies only to
    // pending rows so historical offers don't block future ones.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uniq_dispatch_offer_driver_pending"
        ON "dispatch_offers" ("driverId")
        WHERE "status" = 'pending'
    `);

    // orders.orderRequestId — back-link from a resolved order to
    // the request that spawned it. Nullable; legacy orders stay NULL.
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "orderRequestId" uuid NULL
    `);

    // System config knobs.
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "description", "dataType")
      VALUES
        ('ORDER_REQUEST_TTL_SECONDS', '300',
         'How long a dispatch request stays open (seconds) before being auto-expired. 0 disables auto-expiry (a request must then be cancelled manually).',
         'number'),
        ('DISPATCH_OFFER_TTL_SECONDS', '60',
         'How long a single driver offer stays pending (seconds) before the expiry sweeper marks it expired. The customer must accept within this window or pick a fresher offer.',
         'number'),
        ('ORDER_REQUEST_RADIUS_KM', '5',
         'Initial eligibility radius around the pickup, in km. Used by the request fanout to filter the driver pool. Progressive widening is handled by the request lifecycle, not this knob.',
         'number')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "system_configs" WHERE "key" IN ('ORDER_REQUEST_TTL_SECONDS', 'DISPATCH_OFFER_TTL_SECONDS', 'ORDER_REQUEST_RADIUS_KM')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "orderRequestId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "dispatch_offers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "order_requests"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "dispatch_offer_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "dispatch_offer_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_request_status_enum"`);
  }
}
