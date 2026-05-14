import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRefreshTokensTable1765078667283 implements MigrationInterface {
  name = 'AddRefreshTokensTable1765078667283';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NOTE: As originally authored this migration duplicated every CREATE
    // statement from CreateWalletAndConfigTables1765037485352 (transactions
    // enums + tables, wallets, system_configs, plus their foreign keys).
    // That caused a "type already exists" failure on every fresh run, which
    // the production deploy was masking with `|| true` — meaning the
    // refresh_tokens table was almost certainly never created in production.
    // Slimmed to only the genuinely new work below.
    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "token" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "isRevoked" boolean NOT NULL DEFAULT false, "deviceId" character varying, "ipAddress" character varying, "userAgent" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_4542dd2f38a61354a040ba9fd57" UNIQUE ("token"), CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_610102b60fea1455310ccd299de"`,
    );
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
  }
}
