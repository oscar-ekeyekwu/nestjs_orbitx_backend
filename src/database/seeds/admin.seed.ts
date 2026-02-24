import { DataSource } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../common/enums/user-role.enum';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Default admin credentials (can be overridden by env vars)
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@orbitx.com';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123456';
const DEFAULT_ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || 'Admin';
const DEFAULT_ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || 'User';

async function seedAdmin() {
  console.log('🌱 Starting admin seed...');

  // Create DataSource
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'orbitx',
    entities: [User],
    synchronize: false,
  });

  try {
    await dataSource.initialize();
    console.log('✅ Database connection established');

    const userRepository = dataSource.getRepository(User);

    // Check if admin already exists
    const existingAdmin = await userRepository.findOne({
      where: { email: DEFAULT_ADMIN_EMAIL },
    });

    if (existingAdmin) {
      console.log(`ℹ️  Admin user already exists: ${DEFAULT_ADMIN_EMAIL}`);

      // Update to admin role if not already
      if (existingAdmin.role !== UserRole.ADMIN) {
        existingAdmin.role = UserRole.ADMIN;
        await userRepository.save(existingAdmin);
        console.log('✅ Updated user role to admin');
      }
    } else {
      // Create new admin user
      const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);

      const adminUser = userRepository.create({
        email: DEFAULT_ADMIN_EMAIL,
        password: hashedPassword,
        first_name: DEFAULT_ADMIN_FIRST_NAME,
        last_name: DEFAULT_ADMIN_LAST_NAME,
        role: UserRole.ADMIN,
        isEmailVerified: true,
        isPhoneVerified: false,
        isActive: true,
      });

      await userRepository.save(adminUser);
      console.log(`✅ Admin user created successfully!`);
      console.log(`   Email: ${DEFAULT_ADMIN_EMAIL}`);
      console.log(`   Password: ${DEFAULT_ADMIN_PASSWORD}`);
    }

    await dataSource.destroy();
    console.log('✅ Database connection closed');
    console.log('🌱 Admin seed completed!');
  } catch (error) {
    console.error('❌ Error seeding admin:', error);
    process.exit(1);
  }
}

// Run the seed
seedAdmin();
