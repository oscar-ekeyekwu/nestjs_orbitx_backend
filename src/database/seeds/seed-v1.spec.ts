/* eslint-disable @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/require-await --
 * jest mock introspection is noisy under strict type-checked lint.
 * The async mock factories return values that are syntactically not
 * awaited, but consumers await them — the async modifier preserves
 * the Promise return signature the production code expects. */
import type { DataSource } from 'typeorm';
import { seedAdminUser, seedSystemConfigs } from './seed-v1';
import { User } from '../../users/entities/user.entity';
import { SystemConfig } from '../../config/entities/system-config.entity';
import { UserRole } from '../../common/enums/user-role.enum';
import { DEFAULT_CONFIG_VALUES } from '../../config/enums/config-keys.enum';

const CONFIG_KEY_COUNT = Object.keys(DEFAULT_CONFIG_VALUES).length;

type SimulatedConfig = {
  key: string;
  value: string;
  description: string;
  dataType: string;
};

/**
 * Builds a small in-memory simulation of TypeORM's getRepository
 * shape just for the entities the seed touches. Lets us exercise the
 * upsert paths (insert on first run, update-or-skip on second run)
 * without a real Postgres connection.
 */
function buildDataSource(): {
  ds: DataSource;
  configRows: SimulatedConfig[];
  userRows: Array<{ id: string; email: string; role: UserRole }>;
} {
  const configRows: SimulatedConfig[] = [];
  const userRows: Array<{ id: string; email: string; role: UserRole }> = [];

  const configRepo = {
    findOne: jest.fn(
      async ({ where }: { where: { key: string } }) =>
        configRows.find((c) => c.key === where.key) ?? null,
    ),
    save: jest.fn(async (row: SimulatedConfig) => {
      const existing = configRows.find((c) => c.key === row.key);
      if (existing) Object.assign(existing, row);
      else configRows.push({ ...row });
      return row;
    }),
    create: jest.fn((row: SimulatedConfig) => ({ ...row })),
  };

  const userRepo = {
    findOne: jest.fn(
      async ({ where }: { where: { email: string } }) =>
        userRows.find((u) => u.email === where.email) ?? null,
    ),
    save: jest.fn(
      async (row: { id?: string; email: string; role: UserRole }) => {
        const id = row.id ?? `user-${userRows.length + 1}`;
        const stored = { id, email: row.email, role: row.role };
        const existing = userRows.find((u) => u.email === row.email);
        if (existing) Object.assign(existing, stored);
        else userRows.push(stored);
        return stored;
      },
    ),
    create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
  };

  const ds = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === SystemConfig) return configRepo;
      if (entity === User) return userRepo;
      throw new Error(`Unmocked entity: ${String(entity)}`);
    }),
  } as unknown as DataSource;

  return { ds, configRows, userRows };
}

describe('seed-v1 idempotency (B7)', () => {
  let consoleLog: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  describe('seedSystemConfigs', () => {
    it('inserts every DEFAULT_CONFIG_VALUES key on first run', async () => {
      const { ds, configRows } = buildDataSource();

      await seedSystemConfigs(ds);

      expect(configRows).toHaveLength(CONFIG_KEY_COUNT);
      // Every default key landed.
      for (const key of Object.keys(DEFAULT_CONFIG_VALUES)) {
        expect(configRows.find((r) => r.key === key)).toBeDefined();
      }
    });

    it('does NOT duplicate rows when run twice (B7 idempotency AC)', async () => {
      const { ds, configRows } = buildDataSource();

      await seedSystemConfigs(ds);
      const firstCount = configRows.length;
      await seedSystemConfigs(ds);

      expect(configRows).toHaveLength(firstCount);
      expect(configRows).toHaveLength(CONFIG_KEY_COUNT);
    });

    it('preserves admin-tuned values across re-runs', async () => {
      const { ds, configRows } = buildDataSource();

      await seedSystemConfigs(ds);
      // Simulate the admin changing a value via the system_configs admin
      // UI between deploys.
      const target = configRows.find((c) => c.key === 'DRIVER_MIN_BALANCE');
      expect(target).toBeDefined();
      if (target) target.value = '9999';

      await seedSystemConfigs(ds);

      // The custom value survives — only description/dataType metadata
      // is refreshed by the seed.
      const after = configRows.find((c) => c.key === 'DRIVER_MIN_BALANCE');
      expect(after?.value).toBe('9999');
    });
  });

  describe('seedAdminUser', () => {
    it('creates the admin on first run', async () => {
      const { ds, userRows } = buildDataSource();

      await seedAdminUser(ds);

      expect(userRows).toHaveLength(1);
      expect(userRows[0].email).toBe('admin@orbitx.com');
      expect(userRows[0].role).toBe(UserRole.ADMIN);
    });

    it('does NOT duplicate the admin when run twice (B7 idempotency AC)', async () => {
      const { ds, userRows } = buildDataSource();

      await seedAdminUser(ds);
      await seedAdminUser(ds);

      expect(userRows).toHaveLength(1);
    });

    it('promotes an existing non-admin user with the same email to admin', async () => {
      const { ds, userRows } = buildDataSource();
      userRows.push({
        id: 'user-1',
        email: 'admin@orbitx.com',
        role: UserRole.CUSTOMER,
      });

      await seedAdminUser(ds);

      expect(userRows).toHaveLength(1);
      expect(userRows[0].role).toBe(UserRole.ADMIN);
    });

    it('warns when ADMIN_EMAIL / ADMIN_PASSWORD env vars are absent', async () => {
      const { ds } = buildDataSource();

      await seedAdminUser(ds);

      const warnCalls = consoleWarn.mock.calls.map((args) => args[0] as string);
      expect(
        warnCalls.some((msg) =>
          msg.includes('Using DEFAULT admin credentials'),
        ),
      ).toBe(true);
    });

    it('does NOT warn when ADMIN_EMAIL + ADMIN_PASSWORD are set', async () => {
      process.env.ADMIN_EMAIL = 'real-admin@gemspaysolution.com';
      process.env.ADMIN_PASSWORD = 'a-real-password-from-a-secrets-manager';
      const { ds } = buildDataSource();

      await seedAdminUser(ds);

      const warnCalls = consoleWarn.mock.calls.map((args) => args[0] as string);
      expect(
        warnCalls.some((msg) =>
          msg.includes('Using DEFAULT admin credentials'),
        ),
      ).toBe(false);
    });
  });
});
