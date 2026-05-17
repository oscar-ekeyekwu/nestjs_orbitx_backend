import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import * as path from 'path';
import { User } from '../../users/entities/user.entity';
import { SystemConfig } from '../../config/entities/system-config.entity';
import { UserRole } from '../../common/enums/user-role.enum';
import { DEFAULT_CONFIG_VALUES } from '../../config/enums/config-keys.enum';

dotenv.config();

/**
 * ARCH-2 — Companion seed script for the v1 baseline.
 *
 * Runs after `migration:run` to populate the rows that the application
 * expects to exist: an admin user from env (or sane defaults) and the
 * system_configs table from `DEFAULT_CONFIG_VALUES` (pricing, feature
 * flags). Idempotent — running it twice updates rather than duplicates.
 *
 * Deliberately NOT inside the migration: seed data is environment-specific
 * (different admin emails per env, etc.) and rolls back independently.
 */
async function seedV1() {
  console.log('🌱 [seed-v1] Starting v1 baseline seed...');

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'orbitx',
    synchronize: false,
    entities: [path.join(__dirname, '../../**/*.entity.{ts,js}')],
  });

  try {
    await dataSource.initialize();
    console.log('✅ [seed-v1] Database connection established');

    await seedAdminUser(dataSource);
    await seedSystemConfigs(dataSource);

    await dataSource.destroy();
    console.log('✅ [seed-v1] Database connection closed');
    console.log('🌱 [seed-v1] Baseline seed complete.');
  } catch (error) {
    console.error('❌ [seed-v1] Seed failed:', error);
    process.exit(1);
  }
}

async function seedAdminUser(dataSource: DataSource): Promise<void> {
  const email = process.env.ADMIN_EMAIL || 'admin@orbitx.com';
  const password = process.env.ADMIN_PASSWORD || 'Admin@123456';
  const firstName = process.env.ADMIN_FIRST_NAME || 'Admin';
  const lastName = process.env.ADMIN_LAST_NAME || 'User';

  const userRepo = dataSource.getRepository(User);
  const existing = await userRepo.findOne({ where: { email } });

  if (existing) {
    if (existing.role !== UserRole.ADMIN) {
      existing.role = UserRole.ADMIN;
      await userRepo.save(existing);
      console.log(`✅ [seed-v1] Promoted existing user to admin: ${email}`);
    } else {
      console.log(`ℹ️  [seed-v1] Admin already exists: ${email}`);
    }
    return;
  }

  const hashed = await bcrypt.hash(password, 10);
  const admin = userRepo.create({
    email,
    password: hashed,
    first_name: firstName,
    last_name: lastName,
    role: UserRole.ADMIN,
    isEmailVerified: true,
    isPhoneVerified: false,
    isActive: true,
  });
  await userRepo.save(admin);
  console.log(`✅ [seed-v1] Admin user created: ${email}`);
}

async function seedSystemConfigs(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository(SystemConfig);
  let created = 0;
  let updated = 0;

  for (const [key, defaults] of Object.entries(DEFAULT_CONFIG_VALUES)) {
    const existing = await repo.findOne({ where: { key } });
    if (existing) {
      // Only refresh description / dataType so values an admin tuned by
      // hand are never overwritten by a re-run of the seed.
      let changed = false;
      if (existing.description !== defaults.description) {
        existing.description = defaults.description;
        changed = true;
      }
      if (existing.dataType !== defaults.dataType) {
        existing.dataType = defaults.dataType;
        changed = true;
      }
      if (changed) {
        await repo.save(existing);
        updated += 1;
      }
    } else {
      await repo.save(
        repo.create({
          key,
          value: defaults.value,
          description: defaults.description,
          dataType: defaults.dataType,
        }),
      );
      created += 1;
    }
  }

  console.log(
    `✅ [seed-v1] system_configs — ${created} created, ${updated} metadata-refreshed`,
  );
}

void seedV1();
