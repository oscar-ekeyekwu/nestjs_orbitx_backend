/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import { SystemConfigService } from '../config/config.service';
import { Document } from '../documents/entities/document.entity';
import { S3CompatibleAdapter } from './adapters/s3-compatible.adapter';
import { StorageCryptoService } from './crypto.service';
import {
  StorageProvider,
  StorageProviderKind,
} from './entities/storage-provider.entity';
import { StorageProvidersService } from './storage-providers.service';
import { StorageRegistry } from './storage-registry.service';

function buildRow(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    id: 'prov-1',
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
    createdAt: new Date('2026-05-19T00:00:00Z'),
    updatedAt: new Date('2026-05-19T00:00:00Z'),
    ...overrides,
  } as unknown as StorageProvider;
}

describe('StorageProvidersService', () => {
  let repo: jest.Mocked<Repository<StorageProvider>>;
  let documentRepo: jest.Mocked<Repository<Document>>;
  let dataSource: jest.Mocked<DataSource>;
  let crypto: jest.Mocked<StorageCryptoService>;
  let config: jest.Mocked<SystemConfigService>;
  let approvals: jest.Mocked<ApprovalsService>;
  let registry: jest.Mocked<StorageRegistry>;
  let manager: {
    save: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
    insert: jest.Mock;
  };
  let service: StorageProvidersService;

  const ACTOR = 'admin-uuid';

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<StorageProvider>>;
    documentRepo = {
      count: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<Repository<Document>>;

    manager = {
      save: jest.fn((entityClass: unknown, row: unknown) => {
        // Mirror typeorm's `save(EntityClass, partial)` shape — return a
        // hydrated row by spreading the partial onto the input and
        // synthesising an id if missing.
        const seed = row as Record<string, unknown>;
        return Promise.resolve({
          id: 'prov-new',
          createdAt: new Date('2026-05-19T00:00:00Z'),
          updatedAt: new Date('2026-05-19T00:00:00Z'),
          ...seed,
        });
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    } as unknown as jest.Mocked<DataSource>;

    crypto = {
      encryptSecret: jest.fn().mockReturnValue({
        cipher: Buffer.from('enc'),
        nonce: Buffer.alloc(12, 1),
        tag: Buffer.alloc(16, 2),
        keyVersion: 1,
      }),
      decryptSecret: jest.fn().mockReturnValue('SECRET-PLAINTEXT-1234'),
      maskTrailing: jest.fn().mockReturnValue('••••••1234'),
    } as unknown as jest.Mocked<StorageCryptoService>;

    config = {
      get: jest.fn().mockResolvedValue(null),
      refreshCache: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SystemConfigService>;

    approvals = {
      recordDecision: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ApprovalsService>;

    registry = {
      invalidate: jest.fn(),
    } as unknown as jest.Mocked<StorageRegistry>;

    service = new StorageProvidersService(
      repo,
      documentRepo,
      dataSource,
      crypto,
      config,
      approvals,
      registry,
    );
  });

  describe('list', () => {
    it('returns providers with masked secrets and isActive=true for the active id', async () => {
      const a = buildRow({ id: 'a', slug: 'a' });
      const b = buildRow({ id: 'b', slug: 'b' });
      repo.find.mockResolvedValueOnce([a, b]);
      config.get.mockResolvedValueOnce('b');

      const result = await service.list();

      expect(result.map((p) => p.id)).toEqual(['a', 'b']);
      expect(result[0].isActive).toBe(false);
      expect(result[1].isActive).toBe(true);
      expect(result[0].secretAccessKey.masked).toBe('••••••1234');
      // Plaintext secret is never present anywhere.
      const serialised = JSON.stringify(result);
      expect(serialised).not.toMatch(/SECRET-PLAINTEXT/);
    });

    it('flags the masked secret when decrypt fails (key rotation gone wrong)', async () => {
      crypto.decryptSecret.mockImplementationOnce(() => {
        throw new Error('bad tag');
      });
      repo.find.mockResolvedValueOnce([buildRow()]);

      const [view] = await service.list();
      expect(view.secretAccessKey.masked).toBe('••••••<decrypt failed>');
    });
  });

  describe('create', () => {
    const dto = {
      slug: 'supabase-eu',
      displayName: 'Supabase EU',
      endpoint: 'https://abc.supabase.co/storage/v1/s3',
      region: 'eu-central-1',
      bucket: 'kyc-v1',
      accessKeyId: 'AKIA-EU',
      secretAccessKey: 'plaintext-secret',
    };

    it('encrypts the secret, persists the row, and writes a CREATE audit entry', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      const result = await service.create(dto, ACTOR);

      expect(crypto.encryptSecret).toHaveBeenCalledWith('plaintext-secret');
      const savedArgs = manager.save.mock.calls[0] as [unknown, unknown];
      const saved = savedArgs[1] as Record<string, unknown>;
      expect(saved.slug).toBe('supabase-eu');
      expect(saved.accessKeyId).toBe('AKIA-EU');
      // Plaintext NEVER lands on the row.
      expect(JSON.stringify(saved)).not.toMatch(/plaintext-secret/);
      expect(saved.secretCipher).toBeInstanceOf(Buffer);
      expect(saved.createdBy).toBe(ACTOR);
      expect(saved.updatedBy).toBe(ACTOR);

      expect(approvals.recordDecision).toHaveBeenCalledTimes(1);
      const auditCall = approvals.recordDecision.mock.calls[0][1];
      expect(auditCall).toEqual(
        expect.objectContaining({
          targetType: ApprovalTargetType.STORAGE_PROVIDER,
          action: ApprovalAction.CREATE,
          reviewerId: ACTOR,
        }),
      );

      expect(result.slug).toBe('supabase-eu');
      expect(result.secretAccessKey.masked).toBe('••••••1234');
    });

    it('refuses to create a duplicate slug with 409', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow({ slug: 'supabase-eu' }));
      await expect(service.create(dto, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rotates the encrypted secret when secretAccessKey is supplied', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());

      await service.update('prov-1', { secretAccessKey: 'new-plain' }, ACTOR);

      expect(crypto.encryptSecret).toHaveBeenCalledWith('new-plain');
      const auditCall = approvals.recordDecision.mock.calls[0][1];
      expect(auditCall.action).toBe(ApprovalAction.UPDATE);
      expect(auditCall.reason).toMatch(/secretAccessKey/);
      // Never name the plaintext in the audit row.
      expect(auditCall.reason ?? '').not.toMatch(/new-plain/);
      // STG-3 — flush cached adapter so next lookup picks up the new
      // creds without waiting for natural updatedAt drift.
      expect(registry.invalidate).toHaveBeenCalledWith('prov-1');
    });

    it('skips DB writes when nothing actually changed (idempotent no-op)', async () => {
      const existing = buildRow({ displayName: 'Same Name' });
      repo.findOne.mockResolvedValueOnce(existing);

      const out = await service.update(
        'prov-1',
        { displayName: 'Same Name' },
        ACTOR,
      );

      expect(manager.save).not.toHaveBeenCalled();
      expect(approvals.recordDecision).not.toHaveBeenCalled();
      // No row mutation → no cache invalidation either.
      expect(registry.invalidate).not.toHaveBeenCalled();
      expect(out.id).toBe('prov-1');
    });

    it('names every changed field in the audit row reason', async () => {
      repo.findOne.mockResolvedValueOnce(
        buildRow({
          displayName: 'Old',
          endpoint: 'https://old.example/',
          bucket: 'old-bucket',
        }),
      );

      await service.update(
        'prov-1',
        {
          displayName: 'New',
          endpoint: 'https://new.example/',
          bucket: 'new-bucket',
        },
        ACTOR,
      );

      const auditCall = approvals.recordDecision.mock.calls[0][1];
      expect(auditCall.reason).toMatch(/displayName/);
      expect(auditCall.reason).toMatch(/endpoint/);
      expect(auditCall.reason).toMatch(/bucket/);
    });

    it('throws NotFoundException when the provider does not exist', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update('missing', { displayName: 'x' }, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('refuses to delete the active provider (409 STORAGE_PROVIDER_IN_USE)', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());
      config.get.mockResolvedValueOnce('prov-1');

      let caught: unknown;
      try {
        await service.remove('prov-1', ACTOR);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.code).toBe('STORAGE_PROVIDER_IN_USE');
      expect(response.isActive).toBe(true);
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a provider with referencing documents (409)', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());
      config.get.mockResolvedValueOnce(null);
      documentRepo.count.mockResolvedValueOnce(42);

      let caught: unknown;
      try {
        await service.remove('prov-1', ACTOR);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.code).toBe('STORAGE_PROVIDER_IN_USE');
      expect(response.referencedBy).toBe(42);
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('deletes and writes a DELETE audit row when not active + no references', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());
      config.get.mockResolvedValueOnce(null);
      documentRepo.count.mockResolvedValueOnce(0);

      await service.remove('prov-1', ACTOR);

      expect(manager.delete).toHaveBeenCalledWith(StorageProvider, {
        id: 'prov-1',
      });
      const auditCall = approvals.recordDecision.mock.calls[0][1];
      expect(auditCall.action).toBe(ApprovalAction.DELETE);
      expect(registry.invalidate).toHaveBeenCalledWith('prov-1');
    });
  });

  describe('activate', () => {
    it('upserts system_configs + writes ACTIVATE audit in the same transaction', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());

      const out = await service.activate('prov-1', ACTOR);

      // manager.query handles the system_configs upsert
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/system_configs/);
      expect(params[0]).toBe('storage.activeProviderId');
      expect(params[1]).toBe('prov-1');

      const auditCall = approvals.recordDecision.mock.calls[0][1];
      expect(auditCall.action).toBe(ApprovalAction.ACTIVATE);
      expect(auditCall.targetId).toBe('prov-1');

      expect(config.refreshCache).toHaveBeenCalledTimes(1);
      expect(registry.invalidate).toHaveBeenCalledWith('prov-1');
      expect(out.isActive).toBe(true);
    });

    it('refuses to activate a disabled provider', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow({ enabled: false }));

      await expect(service.activate('prov-1', ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
      expect(approvals.recordDecision).not.toHaveBeenCalled();
    });
  });

  describe('test', () => {
    it('returns ok:true with latencyMs when the adapter probe succeeds', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());
      // Patch the adapter prototype so we don't actually call S3.
      const objectExistsSpy = jest
        .spyOn(S3CompatibleAdapter.prototype, 'objectExists')
        .mockResolvedValue(false);

      const out = await service.test('prov-1');

      expect(out.ok).toBe(true);
      expect(typeof out.latencyMs).toBe('number');
      expect(objectExistsSpy).toHaveBeenCalledWith(
        '__healthcheck/__sentinel__',
      );
      objectExistsSpy.mockRestore();
    });

    it('returns ok:false + sanitised error on auth failure', async () => {
      repo.findOne.mockResolvedValueOnce(buildRow());
      const err = Object.assign(new Error('AccessDenied'), {
        name: 'AccessDenied',
        Code: '403',
      });
      const objectExistsSpy = jest
        .spyOn(S3CompatibleAdapter.prototype, 'objectExists')
        .mockRejectedValue(err);

      const out = await service.test('prov-1');

      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/AccessDenied/);
      objectExistsSpy.mockRestore();
    });
  });
});
