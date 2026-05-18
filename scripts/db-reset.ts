/**
 * B7 — destructive DB reset for dev / staging fresh-env reboots.
 *
 *   npm run db:reset
 *
 * Drops the public schema (every table, enum, index, sequence) and
 * recreates an empty one. Pairs with:
 *
 *   npm run db:reset && npm run migration:run && npm run seed:v1
 *
 * to land back at v1 baseline.
 *
 * Protections:
 *  - Refuses to run if NODE_ENV === 'production'. A separate
 *    production-disaster runbook covers prod resets; this script is
 *    NOT it.
 *  - Refuses to run unless the FORCE_DB_RESET=true env var is set.
 *    Two-factor guard against accidental npm run db:reset on a dev
 *    machine that's pointed at staging.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  const env = process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    console.error(
      '✋ Refusing to reset the database with NODE_ENV=production. ' +
        'If you truly need a prod reset, follow deploy/README.md and run the SQL by hand.',
    );
    process.exit(1);
  }

  if (process.env.FORCE_DB_RESET !== 'true') {
    console.error(
      '✋ db:reset requires FORCE_DB_RESET=true to run.\n' +
        '   This drops every table in the public schema and is irreversible.\n' +
        '   Run with: FORCE_DB_RESET=true npm run db:reset',
    );
    process.exit(1);
  }

  const database = process.env.DB_NAME ?? 'orbitx';
  const host = process.env.DB_HOST ?? 'localhost';

  console.log(
    `🧨 db:reset — dropping public schema in ${database}@${host} (NODE_ENV=${env}).`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    host,
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database,
    synchronize: false,
  });

  try {
    await dataSource.initialize();
    // DROP SCHEMA CASCADE wipes tables, enums, sequences, indexes,
    // and the migrations table itself. The next migration:run
    // starts the history afresh — exactly what we want for v1 reset.
    await dataSource.query('DROP SCHEMA IF EXISTS public CASCADE');
    await dataSource.query('CREATE SCHEMA public');
    // Restore default privileges so non-superuser connections work.
    await dataSource.query(
      `GRANT ALL ON SCHEMA public TO ${process.env.DB_USERNAME ?? 'postgres'}`,
    );
    await dataSource.query(`GRANT ALL ON SCHEMA public TO public`);
    console.log('✅ public schema dropped and recreated.');
    console.log(
      '   Next: npm run migration:run && npm run seed:v1 to land at v1 baseline.',
    );
    await dataSource.destroy();
  } catch (error) {
    console.error('❌ db:reset failed:', error);
    process.exit(1);
  }
}

void main();
