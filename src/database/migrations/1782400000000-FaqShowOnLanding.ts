import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets admins curate a subset of FAQs for the public marketing site
 * (orbitx-landing) independent of `isActive`, which controls
 * visibility in the mobile apps. Defaults to false so existing FAQs
 * don't suddenly appear on the landing page.
 */
export class FaqShowOnLanding1782400000000 implements MigrationInterface {
  name = 'FaqShowOnLanding1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "faqs"
      ADD COLUMN "showOnLanding" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "faqs" DROP COLUMN "showOnLanding"
    `);
  }
}
