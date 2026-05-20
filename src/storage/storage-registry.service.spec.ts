/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SystemConfigService } from '../config/config.service';
import { StorageCryptoService } from './crypto.service';
import {
  StorageProvider,
  StorageProviderKind,
} from './entities/storage-provider.entity';
import { StorageRegistry } from './storage-registry.service';

function buildRow(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    id: 'provider-1',
    slug: 'spaces-default',
    kind: StorageProviderKind.S3_COMPATIBLE,
    displayName: 'DigitalOcean Spaces',
    endpoint: 'https://nyc3.digitaloceanspaces.com',
    region: 'nyc3',
    bucket: 'orbit-kyc-v1',
    accessKeyId: 'AKIA-EXAMPLE',
    secretCipher: Buffer.from('cipher'),
    secretNonce: Buffer.alloc(12),
    secretTag: Buffer.alloc(16),
    keyVersion: 1,
    enabled: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as StorageProvider;
}

describe('StorageRegistry', () => {
  let repo: jest.Mocked<Repository<StorageProvider>>;
  let config: jest.Mocked<SystemConfigService>;
  let crypto: jest.Mocked<StorageCryptoService>;
  let registry: StorageRegistry;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<StorageProvider>>;
    config = {
      get: jest.fn(),
    } as unknown as jest.Mocked<SystemConfigService>;
    crypto = {
      decryptSecret: jest.fn().mockReturnValue('secret-plaintext'),
    } as unknown as jest.Mocked<StorageCryptoService>;
    registry = new StorageRegistry(repo, config, crypto);
  });

  describe('getActive', () => {
    it('reads the active provider id from system_configs and resolves it', async () => {
      config.get.mockResolvedValueOnce('provider-1');
      repo.findOne.mockResolvedValueOnce(buildRow());

      const adapter = await registry.getActive();

      expect(config.get).toHaveBeenCalledWith('storage.activeProviderId', null);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'provider-1' },
      });
      expect(crypto.decryptSecret).toHaveBeenCalledTimes(1);
      expect(adapter.providerId).toBe('provider-1');
      expect(adapter.providerSlug).toBe('spaces-default');
      expect(adapter.bucket).toBe('orbit-kyc-v1');
    });

    it('throws when no active provider is configured', async () => {
      config.get.mockResolvedValueOnce(null);

      await expect(registry.getActive()).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('get', () => {
    it('resolves a non-active provider by id (read of a doc on a now-deactivated provider)', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow({ id: 'old-provider' }));

      const adapter = await registry.get('old-provider');

      // The registry must NOT consult the active-provider config for
      // lookups by id — it routes directly off the requested id.
      expect(config.get).not.toHaveBeenCalled();
      expect(adapter.providerId).toBe('old-provider');
    });

    it('throws NotFoundException when the id has no row', async () => {
      repo.findOne.mockResolvedValueOnce(null);

      await expect(registry.get('does-not-exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to build an adapter for a disabled provider', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow({ enabled: false }));

      await expect(registry.get('provider-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('decrypts the secret access key via the crypto service', async () => {
      repo.findOne.mockResolvedValueOnce(
        buildRow({
          secretCipher: Buffer.from('c'),
          secretNonce: Buffer.alloc(12, 7),
          secretTag: Buffer.alloc(16, 9),
          keyVersion: 1,
        }),
      );

      await registry.get('provider-1');

      expect(crypto.decryptSecret).toHaveBeenCalledWith({
        cipher: Buffer.from('c'),
        nonce: Buffer.alloc(12, 7),
        tag: Buffer.alloc(16, 9),
        keyVersion: 1,
      });
    });
  });

  describe('LRU+TTL cache (STG-3)', () => {
    it('returns the same adapter instance on a cache hit (decrypt runs once)', async () => {
      const row = buildRow();
      repo.findOne.mockResolvedValue(row);

      const first = await registry.get('provider-1');
      const second = await registry.get('provider-1');

      expect(second).toBe(first);
      expect(crypto.decryptSecret).toHaveBeenCalledTimes(1);
      expect(registry.cacheSize()).toBe(1);
    });

    it('rebuilds when the row updatedAt advances (admin credential rotation in another process)', async () => {
      const v1 = buildRow({ updatedAt: new Date('2026-05-19T00:00:00Z') });
      repo.findOne.mockResolvedValueOnce(v1);
      const first = await registry.get('provider-1');

      const v2 = buildRow({ updatedAt: new Date('2026-05-19T00:00:01Z') });
      repo.findOne.mockResolvedValueOnce(v2);
      const second = await registry.get('provider-1');

      expect(second).not.toBe(first);
      expect(crypto.decryptSecret).toHaveBeenCalledTimes(2);
    });

    it('invalidate(id) flushes every cached adapter for that provider', async () => {
      const row = buildRow();
      repo.findOne.mockResolvedValue(row);

      await registry.get('provider-1');
      expect(registry.cacheSize()).toBe(1);

      registry.invalidate('provider-1');
      expect(registry.cacheSize()).toBe(0);

      await registry.get('provider-1');
      // decrypt ran a second time after the invalidate (we lost the
      // cached adapter and had to rebuild).
      expect(crypto.decryptSecret).toHaveBeenCalledTimes(2);
    });

    it('invalidate(id) only flushes entries for that provider id', async () => {
      const a = buildRow({ id: 'a' });
      const b = buildRow({ id: 'b' });
      repo.findOne.mockImplementation(({ where }) => {
        const id = (where as { id: string }).id;
        return Promise.resolve(id === 'a' ? a : b);
      });

      await registry.get('a');
      await registry.get('b');
      expect(registry.cacheSize()).toBe(2);

      registry.invalidate('a');
      expect(registry.cacheSize()).toBe(1);
    });

    it('evicts the least-recently-used entry once size exceeds 16', async () => {
      // Seed 17 distinct provider ids.
      for (let i = 0; i < 17; i++) {
        const row = buildRow({ id: `p-${i}` });
        repo.findOne.mockResolvedValueOnce(row);
        await registry.get(`p-${i}`);
      }

      // Hard cap holds at 16; oldest insertion (p-0) is the one evicted.
      expect(registry.cacheSize()).toBe(16);

      // The next get for p-0 must re-build (decrypt count +1).
      const callsBefore = crypto.decryptSecret.mock.calls.length;
      repo.findOne.mockResolvedValueOnce(buildRow({ id: 'p-0' }));
      await registry.get('p-0');
      expect(crypto.decryptSecret.mock.calls.length).toBe(callsBefore + 1);
    });

    it('rebuilds when the TTL has elapsed', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-05-19T12:00:00Z'));
        const row = buildRow();
        repo.findOne.mockResolvedValue(row);

        await registry.get('provider-1');
        expect(crypto.decryptSecret).toHaveBeenCalledTimes(1);

        // Advance past the 5-minute TTL.
        jest.setSystemTime(new Date('2026-05-19T12:05:01Z'));

        await registry.get('provider-1');
        expect(crypto.decryptSecret).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
