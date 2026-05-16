import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationTemplates1779600000000
  implements MigrationInterface
{
  name = 'CreateNotificationTemplates1779600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."notification_templates_eventtype_enum" AS ENUM(
        'order_created', 'order_accepted', 'order_picked_up',
        'order_in_transit', 'order_delivered', 'order_cancelled',
        'payment_success', 'payment_failed', 'new_message'
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "notification_templates" (
        "eventType" "public"."notification_templates_eventtype_enum" NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "emailSubject" character varying,
        "emailBody" text,
        "smsBody" text,
        "isEnabled" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_templates" PRIMARY KEY ("eventType")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_templates"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."notification_templates_eventtype_enum"`,
    );
  }
}
