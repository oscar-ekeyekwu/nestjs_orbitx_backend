import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSupportTickets1779500000000 implements MigrationInterface {
  name = 'CreateSupportTickets1779500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."support_tickets_status_enum" AS ENUM('open', 'in_progress', 'resolved', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."support_tickets_priority_enum" AS ENUM('low', 'medium', 'high', 'urgent')`,
    );
    await queryRunner.query(
      `CREATE TABLE "support_tickets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "subject" character varying NOT NULL,
        "description" text NOT NULL,
        "status" "public"."support_tickets_status_enum" NOT NULL DEFAULT 'open',
        "priority" "public"."support_tickets_priority_enum" NOT NULL DEFAULT 'medium',
        "orderId" uuid,
        "assignedTo" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_tickets" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_userId" ON "support_tickets" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_status" ON "support_tickets" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_priority" ON "support_tickets" ("priority")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_support_tickets_priority"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_support_tickets_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_support_tickets_userId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "support_tickets"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."support_tickets_priority_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."support_tickets_status_enum"`,
    );
  }
}
