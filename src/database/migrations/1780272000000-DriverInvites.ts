import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D4 — driver_invites table. A company_owner POSTs an invite for a
 * driver's phone number; the backend mints a token, sends an SMS,
 * and on the prospective driver's registration the token is
 * redeemed to pre-link them to the inviting company.
 *
 * Constraints:
 *   - token is unique (uuid); used as the public link parameter.
 *   - expiresAt is 7 days from creation by default (set in service).
 *   - usedAt nullable; flipped to now() exactly once on redemption.
 *   - FK to companies(id) ON DELETE CASCADE so suspending a company
 *     also nukes its outstanding invites (no orphan tokens).
 *   - FK to users(id) for createdBy ON DELETE NO ACTION.
 *
 * Indexes:
 *   - token (unique) for the redemption lookup.
 *   - companyId for the company-owned listing.
 *   - phone for "did I already invite this driver?" checks.
 */
export class DriverInvites1780272000000 implements MigrationInterface {
  name = 'DriverInvites1780272000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "driver_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "companyId" uuid NOT NULL,
        "phone" character varying NOT NULL,
        "token" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "expiresAt" TIMESTAMP NOT NULL,
        "usedAt" TIMESTAMP,
        "redeemedByUserId" uuid,
        "createdBy" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_driver_invites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_driver_invites_token" UNIQUE ("token"),
        CONSTRAINT "FK_driver_invites_companyId" FOREIGN KEY ("companyId")
          REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_driver_invites_createdBy" FOREIGN KEY ("createdBy")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_driver_invites_redeemedByUserId"
          FOREIGN KEY ("redeemedByUserId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_invites_companyId" ON "driver_invites" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_invites_phone" ON "driver_invites" ("phone")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_driver_invites_phone"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_driver_invites_companyId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "driver_invites"`);
  }
}
