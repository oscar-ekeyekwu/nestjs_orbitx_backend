// scripts/generate-migration.js
require('dotenv').config();
const { execSync } = require('child_process');

const name = process.argv[2];
if (!name) {
  console.error('❌ Please provide a migration name.');
  process.exit(1);
}

const command = `ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli.js migration:generate src/database/migrations/${name} -d ./ormconfig.ts`;
console.log(`🚀 Running: ${command}`);
execSync(command, { stdio: 'inherit' });
