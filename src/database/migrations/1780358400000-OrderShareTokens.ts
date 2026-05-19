import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * E3 — Public read-only tracking links.
 *
 * One row per active share token. A customer requests a token via
 * POST /orders/:id/share-token; the share URL embeds the token and is
 * resolvable without auth at GET /api/v1/track/:token (which returns
 * the stripped read-only snapshot).
 *
 * Token reuse is enforced at the application layer (unique index on
 * orderId means only one active token per order; the service finds the
 * existing row and returns its token when the customer re-requests).
 *
 * expiresAt is nullable — for an in-progress order the token has no
 * fixed expiry yet; the public endpoint computes the cutoff against
 * the order's deliveredAt at read time so we never need a background
 * job to update this column.
 */
export class OrderShareTokens1780358400000 implements MigrationInterface {
  name = 'OrderShareTokens1780358400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "order_share_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "token" varchar(64) NOT NULL,
        "orderId" uuid NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_share_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_order_share_tokens_token" UNIQUE ("token"),
        CONSTRAINT "UQ_order_share_tokens_orderId" UNIQUE ("orderId"),
        CONSTRAINT "FK_order_share_tokens_order"
          FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_order_share_tokens_token"
        ON "order_share_tokens" ("token")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_order_share_tokens_token"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "order_share_tokens"`);
  }
}
