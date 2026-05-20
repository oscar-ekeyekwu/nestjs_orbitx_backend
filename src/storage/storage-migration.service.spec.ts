/* eslint-disable @typescript-eslint/unbound-method --
 * jest mock introspection is noisy under strict type-checked lint. */
import { Readable } from 'stream';
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
import { Document } from '../documents/entities/document.entity';
import { DeleteSourceDto } from './dto/delete-source.dto';
import {
  StorageMigrationDeletion,
  StorageMigrationDeletionStatus,
} from './entities/storage-migration-deletion.entity';
import {
  StorageMigrationVerification,
  StorageMigrationVerificationStatus,
} from './entities/storage-migration-verification.entity';
import {
  StorageMigration,
  StorageMigrationStatus,
} from './entities/storage-migration.entity';
import { StorageMigrationFailure } from './entities/storage-migration-failure.entity';
import { StorageProvider } from './entities/storage-provider.entity';
import type { StorageAdapter } from './storage-adapter.interface';
import {
  StorageMigrationService,
  expectedConfirmPhrase,
} from './storage-migration.service';
import { StorageRegistry } from './storage-registry.service';

const ACTOR = 'admin-uuid';

function buildProviderRow(id: string, slug = id): StorageProvider {
  return {
    id,
    slug,
    bucket: `bucket-${id}`,
    endpoint: 'https://example.test',
  } as unknown as StorageProvider;
}

function buildDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    storageProviderId: 'src',
    fileKey: 'user/u/nin/abc.jpg',
    fileUrl: 'https://example.test/bucket-src/user/u/nin/abc.jpg',
    createdAt: new Date('2026-05-19T00:00:00Z'),
    ...overrides,
  } as unknown as Document;
}

function buildMigration(
  overrides: Partial<StorageMigration> = {},
): StorageMigration {
  return {
    id: 'mig-1',
    fromProviderId: 'src',
    toProviderId: 'dst',
    status: StorageMigrationStatus.QUEUED,
    dryRun: false,
    batchSize: 25,
    since: null,
    queuedAt: new Date('2026-05-19T10:00:00Z'),
    queuedUntilCreatedAt: new Date('2026-05-19T10:00:00Z'),
    startedAt: null,
    finishedAt: null,
    totalDocuments: 0,
    migratedCount: 0,
    wouldMigrateCount: 0,
    failedCount: 0,
    skippedCount: 0,
    lastDocumentId: null,
    startedBy: ACTOR,
    errorMessage: null,
    createdAt: new Date('2026-05-19T10:00:00Z'),
    updatedAt: new Date('2026-05-19T10:00:00Z'),
    ...overrides,
  } as unknown as StorageMigration;
}

function buildAdapter(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    providerId: 'src',
    providerSlug: 'src-slug',
    bucket: 'bucket-src',
    generateUploadUrl: jest.fn(),
    generateViewUrl: jest.fn(),
    uploadBuffer: jest.fn().mockResolvedValue(undefined),
    objectExists: jest.fn().mockResolvedValue(true),
    getStream: jest.fn(() =>
      Promise.resolve(Readable.from([Buffer.from('payload')])),
    ),
    delete: jest.fn(),
    canonicalUri: jest.fn(
      (key: string) => `https://example.test/bucket-src/${key}`,
    ),
    ...overrides,
  } as unknown as StorageAdapter;
}

describe('StorageMigrationService', () => {
  let migrationsRepo: jest.Mocked<Repository<StorageMigration>>;
  let failuresRepo: jest.Mocked<Repository<StorageMigrationFailure>>;
  let verificationsRepo: jest.Mocked<Repository<StorageMigrationVerification>>;
  let deletionsRepo: jest.Mocked<Repository<StorageMigrationDeletion>>;
  let providersRepo: jest.Mocked<Repository<StorageProvider>>;
  let documentsRepo: jest.Mocked<Repository<Document>>;
  let dataSource: jest.Mocked<DataSource>;
  let registry: jest.Mocked<StorageRegistry>;
  let approvals: jest.Mocked<ApprovalsService>;
  // STG-5 — store the latest verification + deletion writes by spec-side
  // mocks so individual tests can read them back.
  let lastVerification: Partial<StorageMigrationVerification> | null;
  let savedDeletions: Partial<StorageMigrationDeletion>[];
  let manager: {
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
  };
  let migrationRow: StorageMigration;
  let migratedDocIds: string[];

  beforeEach(() => {
    migrationRow = buildMigration();
    migratedDocIds = [];

    migrationsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(() => Promise.resolve({ ...migrationRow })),
      update: jest.fn((_where: unknown, patch: Record<string, unknown>) => {
        Object.assign(migrationRow, patch);
        return Promise.resolve({ affected: 1 });
      }),
      increment: jest.fn(
        (_where: unknown, field: keyof StorageMigration, amount: number) => {
          const cur = (migrationRow[field] as number) ?? 0;
          (migrationRow as unknown as Record<string, unknown>)[
            field as string
          ] = cur + amount;
          return Promise.resolve({ affected: 1 });
        },
      ),
    } as unknown as jest.Mocked<Repository<StorageMigration>>;

    failuresRepo = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<StorageMigrationFailure>>;

    lastVerification = null;
    verificationsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(() => Promise.resolve(lastVerification)),
      update: jest.fn((_where: unknown, patch: Record<string, unknown>) => {
        if (lastVerification) Object.assign(lastVerification, patch);
        return Promise.resolve({ affected: 1 });
      }),
    } as unknown as jest.Mocked<Repository<StorageMigrationVerification>>;

    savedDeletions = [];
    deletionsRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((row: Partial<StorageMigrationDeletion>) => {
        savedDeletions.push(row);
        return Promise.resolve({ id: 'del-new', ...row });
      }),
    } as unknown as jest.Mocked<Repository<StorageMigrationDeletion>>;

    providersRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<StorageProvider>>;

    documentsRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<Document>>;

    manager = {
      save: jest.fn((entity: unknown, row: Record<string, unknown>) => {
        if (entity === StorageMigrationVerification) {
          lastVerification = {
            id: 'verif-new',
            status: StorageMigrationVerificationStatus.RUNNING,
            verifiedCount: 0,
            missingAtDestination: 0,
            totalChecked: 0,
            ...row,
          } as unknown as StorageMigrationVerification;
          return Promise.resolve(lastVerification);
        }
        return Promise.resolve({ id: 'mig-new', ...row });
      }),
      update: jest.fn(
        (
          entity: unknown,
          where: Record<string, unknown>,
          patch: Record<string, unknown>,
        ) => {
          if (entity === Document) {
            const id = (where as { id: string }).id;
            migratedDocIds.push(id);
          }
          if (entity === StorageMigration) {
            Object.assign(migrationRow, patch);
          }
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (
          entity: unknown,
          _where: unknown,
          field: keyof StorageMigration,
          amount: number,
        ) => {
          if (entity === StorageMigration) {
            const cur = (migrationRow[field] as number) ?? 0;
            (migrationRow as unknown as Record<string, unknown>)[
              field as string
            ] = cur + amount;
          }
          return Promise.resolve({ affected: 1 });
        },
      ),
    };

    dataSource = {
      manager: {} as unknown,
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    } as unknown as jest.Mocked<DataSource>;

    registry = {
      get: jest.fn().mockResolvedValue(buildAdapter()),
      invalidate: jest.fn(),
    } as unknown as jest.Mocked<StorageRegistry>;

    approvals = {
      recordDecision: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ApprovalsService>;
  });

  function makeService(): StorageMigrationService {
    return new StorageMigrationService(
      migrationsRepo,
      failuresRepo,
      verificationsRepo,
      deletionsRepo,
      providersRepo,
      documentsRepo,
      dataSource,
      registry,
      approvals,
    );
  }

  describe('start', () => {
    it('queues a migration row with the anchor + total + audit entry', async () => {
      providersRepo.findOne.mockResolvedValueOnce(buildProviderRow('src'));
      providersRepo.findOne.mockResolvedValueOnce(buildProviderRow('dst'));
      documentsRepo.count.mockResolvedValueOnce(42);

      const service = makeService();
      const created = await service.start(
        { fromProviderId: 'src', toProviderId: 'dst' },
        ACTOR,
      );

      const savedArgs = manager.save.mock.calls[0] as [unknown, unknown];
      const saved = savedArgs[1] as Record<string, unknown>;
      expect(saved.fromProviderId).toBe('src');
      expect(saved.toProviderId).toBe('dst');
      expect(saved.totalDocuments).toBe(42);
      expect(saved.queuedUntilCreatedAt).toBeInstanceOf(Date);

      const audit = approvals.recordDecision.mock.calls[0][1];
      expect(audit).toEqual(
        expect.objectContaining({
          targetType: ApprovalTargetType.STORAGE_MIGRATION,
          action: ApprovalAction.CREATE,
          reviewerId: ACTOR,
        }),
      );

      expect(created).toBeDefined();
    });

    it('refuses to start a second migration concurrently (409)', async () => {
      providersRepo.findOne.mockResolvedValue(buildProviderRow('src'));
      const service = makeService();
      // First start succeeds + sets currentMigrationId. The
      // setImmediate-scheduled loop runs async; mark the in-flight
      // state explicitly to test the gate.
      await service.start(
        { fromProviderId: 'src', toProviderId: 'dst' },
        ACTOR,
      );

      providersRepo.findOne.mockResolvedValue(buildProviderRow('src'));
      await expect(
        service.start({ fromProviderId: 'src', toProviderId: 'dst' }, ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException when either provider is missing', async () => {
      providersRepo.findOne.mockResolvedValueOnce(null);
      const service = makeService();
      await expect(
        service.start({ fromProviderId: 'src', toProviderId: 'dst' }, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('runLoop — real run', () => {
    it('streams source → uploads dest, flips storage_provider_id, increments migratedCount', async () => {
      migrationRow = buildMigration({
        id: 'mig-1',
        fromProviderId: 'src',
        toProviderId: 'dst',
        status: StorageMigrationStatus.QUEUED,
      });
      const docA = buildDoc({ id: 'doc-a' });
      const docB = buildDoc({ id: 'doc-b' });
      documentsRepo.find
        .mockResolvedValueOnce([docA, docB])
        .mockResolvedValueOnce([]);

      const fromAdapter = buildAdapter({ providerId: 'src' });
      const toAdapter = buildAdapter({
        providerId: 'dst',
        bucket: 'bucket-dst',
      });
      registry.get
        .mockResolvedValueOnce(fromAdapter)
        .mockResolvedValueOnce(toAdapter);

      const service = makeService();
      await service.runLoop('mig-1');

      // Both docs uploaded into dst.
      expect(toAdapter.uploadBuffer).toHaveBeenCalledTimes(2);
      // storage_provider_id flipped via the manager.update on Document.
      expect(migratedDocIds.sort()).toEqual(['doc-a', 'doc-b']);
      // Final status is 'completed' when no failures.
      expect(migrationRow.status).toBe(StorageMigrationStatus.COMPLETED);
      expect(migrationRow.migratedCount).toBe(2);
      expect(migrationRow.failedCount).toBe(0);
      expect(migrationRow.finishedAt).toBeInstanceOf(Date);
    });

    it('dry run records wouldMigrateCount and does NOT upload', async () => {
      migrationRow = buildMigration({ dryRun: true });
      const docA = buildDoc({ id: 'doc-a' });
      documentsRepo.find
        .mockResolvedValueOnce([docA])
        .mockResolvedValueOnce([]);

      const fromAdapter = buildAdapter({ providerId: 'src' });
      const toAdapter = buildAdapter({ providerId: 'dst' });
      registry.get
        .mockResolvedValueOnce(fromAdapter)
        .mockResolvedValueOnce(toAdapter);

      const service = makeService();
      await service.runLoop('mig-1');

      expect(fromAdapter.objectExists).toHaveBeenCalledWith(docA.fileKey);
      expect(toAdapter.uploadBuffer).not.toHaveBeenCalled();
      expect(migratedDocIds).toEqual([]);
      expect(migrationRow.wouldMigrateCount).toBe(1);
      expect(migrationRow.migratedCount).toBe(0);
    });

    it('retries a failing copy and records a failure once the budget exhausts', async () => {
      jest.useFakeTimers();
      try {
        const docA = buildDoc({ id: 'doc-a' });
        documentsRepo.find
          .mockResolvedValueOnce([docA])
          .mockResolvedValueOnce([]);

        const fromAdapter = buildAdapter({
          providerId: 'src',
          getStream: jest
            .fn()
            .mockRejectedValueOnce(new Error('network blip'))
            .mockRejectedValueOnce(new Error('network blip'))
            .mockRejectedValueOnce(new Error('network blip'))
            .mockRejectedValueOnce(new Error('still down')),
        });
        const toAdapter = buildAdapter({ providerId: 'dst' });
        registry.get
          .mockResolvedValueOnce(fromAdapter)
          .mockResolvedValueOnce(toAdapter);

        const service = makeService();
        const loopPromise = service.runLoop('mig-1');

        // Drain the retry backoff timers (1s + 4s + 16s = 21s).
        await jest.advanceTimersByTimeAsync(21_000);
        await loopPromise;

        expect(fromAdapter.getStream).toHaveBeenCalledTimes(4);
        expect(migrationRow.failedCount).toBe(1);
        expect(migrationRow.migratedCount).toBe(0);
        expect(migrationRow.status).toBe(
          StorageMigrationStatus.COMPLETED_WITH_ERRORS,
        );
        expect(manager.save).toHaveBeenCalledWith(
          StorageMigrationFailure,
          expect.objectContaining({
            documentId: 'doc-a',
            errorMessage: expect.stringMatching(
              /still down|network blip/,
            ) as unknown,
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses to migrate an oversized document (50 MB cap) and records a failure', async () => {
      const docA = buildDoc({ id: 'doc-a' });
      documentsRepo.find
        .mockResolvedValueOnce([docA])
        .mockResolvedValueOnce([]);

      const oversized = Readable.from([Buffer.alloc(51 * 1024 * 1024)]);
      const fromAdapter = buildAdapter({
        providerId: 'src',
        getStream: jest.fn().mockResolvedValue(oversized),
      });
      const toAdapter = buildAdapter({ providerId: 'dst' });
      registry.get
        .mockResolvedValueOnce(fromAdapter)
        .mockResolvedValueOnce(toAdapter);

      const service = makeService();
      const loopPromise = service.runLoop('mig-1');
      // The size-cap throw triggers retries — drain them.
      jest.useFakeTimers();
      try {
        await jest.advanceTimersByTimeAsync(21_000);
        await loopPromise;
      } finally {
        jest.useRealTimers();
      }

      expect(toAdapter.uploadBuffer).not.toHaveBeenCalled();
      expect(migrationRow.failedCount).toBe(1);
    });

    it('pause request stops the loop between batches', async () => {
      const docA = buildDoc({ id: 'doc-a' });
      documentsRepo.find
        .mockResolvedValueOnce([docA])
        .mockResolvedValueOnce([]);

      const fromAdapter = buildAdapter({ providerId: 'src' });
      const toAdapter = buildAdapter({ providerId: 'dst' });
      registry.get
        .mockResolvedValueOnce(fromAdapter)
        .mockResolvedValueOnce(toAdapter);

      const service = makeService();
      // Hook pause request after the first batch begins. We trigger
      // pause via the public method — it requires currentMigrationId
      // to be set, so we seed it manually.

      (
        service as unknown as { currentMigrationId: string | null }
      ).currentMigrationId = 'mig-1';

      (service as unknown as { pauseRequested: boolean }).pauseRequested = true;

      await service.runLoop('mig-1');

      // Worker checks pause before fetching the first batch, so no
      // upload happens.
      expect(toAdapter.uploadBuffer).not.toHaveBeenCalled();
      expect(migrationRow.status).toBe(StorageMigrationStatus.PAUSED);
    });
  });

  describe('resume', () => {
    it('refuses to resume when another migration is currently running (409)', async () => {
      const service = makeService();

      (
        service as unknown as { currentMigrationId: string | null }
      ).currentMigrationId = 'mig-other';
      await expect(service.resume('mig-1', ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses to resume a non-paused migration', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
      });
      const service = makeService();
      await expect(service.resume('mig-1', ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('pause', () => {
    it('refuses to pause a migration that is not running in this process', async () => {
      const service = makeService();
      await expect(service.pause('mig-1', ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('queuedUntilCreatedAt anchor', () => {
    it('uses the anchor as the upper bound when counting + fetching', async () => {
      providersRepo.findOne.mockResolvedValueOnce(buildProviderRow('src'));
      providersRepo.findOne.mockResolvedValueOnce(buildProviderRow('dst'));
      documentsRepo.count.mockResolvedValueOnce(10);

      const service = makeService();
      await service.start(
        { fromProviderId: 'src', toProviderId: 'dst' },
        ACTOR,
      );

      const countCall = documentsRepo.count.mock.calls[0][0] as {
        where?: Record<string, unknown>;
      };
      expect(countCall.where).toEqual(
        expect.objectContaining({ storageProviderId: 'src' }),
      );
      // The upper-bound filter is encoded as a TypeORM operator object;
      // we just assert the field is present + non-null.
      expect(countCall.where?.createdAt).toBeDefined();
    });
  });

  // STG-5 ─────────────────────────────────────────────────────────────────

  describe('verify', () => {
    it('refuses to verify a migration that is still running (409)', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.RUNNING,
      });
      const service = makeService();
      await expect(service.verify('mig-1', ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses a second concurrent verify with VERIFY_ALREADY_RUNNING', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
      });
      const service = makeService();
      (
        service as unknown as { verifyingMigrationIds: Set<string> }
      ).verifyingMigrationIds.add('mig-1');

      let caught: unknown;
      try {
        await service.verify('mig-1', ACTOR);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.code).toBe('VERIFY_ALREADY_RUNNING');
    });

    it('verify loop completes with status=completed when every doc exists at the destination', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        toProviderId: 'dst',
        queuedUntilCreatedAt: new Date('2026-05-19T10:00:00Z'),
      });
      const docs = [
        buildDoc({ id: 'doc-a', storageProviderId: 'dst' }),
        buildDoc({ id: 'doc-b', storageProviderId: 'dst' }),
      ];
      documentsRepo.find.mockResolvedValueOnce(docs).mockResolvedValueOnce([]);

      const toAdapter = buildAdapter({
        providerId: 'dst',
        objectExists: jest.fn().mockResolvedValue(true),
        generateViewUrl: jest.fn().mockResolvedValue('https://signed/'),
      });
      registry.get.mockResolvedValueOnce(toAdapter);

      const service = makeService();
      // Seed the verification row so runVerifyLoop can find it.
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.RUNNING,
        verifiedCount: 0,
        missingAtDestination: 0,
        totalChecked: 0,
      } as unknown as StorageMigrationVerification;

      await service.runVerifyLoop('verif-1', migrationRow);

      expect(lastVerification.status).toBe(
        StorageMigrationVerificationStatus.COMPLETED,
      );
      expect(lastVerification.verifiedCount).toBe(2);
      expect(lastVerification.missingAtDestination).toBe(0);
    });

    it('verify loop completes_with_gaps when objectExists returns false for any doc', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
      });
      documentsRepo.find
        .mockResolvedValueOnce([
          buildDoc({ id: 'doc-a', storageProviderId: 'dst' }),
        ])
        .mockResolvedValueOnce([]);

      const toAdapter = buildAdapter({
        providerId: 'dst',
        objectExists: jest.fn().mockResolvedValue(false),
        generateViewUrl: jest.fn().mockResolvedValue('https://signed/'),
      });
      registry.get.mockResolvedValueOnce(toAdapter);

      const service = makeService();
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.RUNNING,
        verifiedCount: 0,
        missingAtDestination: 0,
        totalChecked: 0,
      } as unknown as StorageMigrationVerification;

      await service.runVerifyLoop('verif-1', migrationRow);

      expect(lastVerification.status).toBe(
        StorageMigrationVerificationStatus.COMPLETED_WITH_GAPS,
      );
      expect(lastVerification.missingAtDestination).toBe(1);
    });

    it('treats generateViewUrl failures as missing at destination', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
      });
      documentsRepo.find
        .mockResolvedValueOnce([
          buildDoc({ id: 'doc-a', storageProviderId: 'dst' }),
        ])
        .mockResolvedValueOnce([]);

      const toAdapter = buildAdapter({
        providerId: 'dst',
        objectExists: jest.fn().mockResolvedValue(true),
        generateViewUrl: jest
          .fn()
          .mockRejectedValue(new Error('signing pipeline blown')),
      });
      registry.get.mockResolvedValueOnce(toAdapter);

      const service = makeService();
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.RUNNING,
        verifiedCount: 0,
        missingAtDestination: 0,
        totalChecked: 0,
      } as unknown as StorageMigrationVerification;

      await service.runVerifyLoop('verif-1', migrationRow);

      expect(lastVerification.status).toBe(
        StorageMigrationVerificationStatus.COMPLETED_WITH_GAPS,
      );
      expect(lastVerification.missingAtDestination).toBe(1);
    });
  });

  describe('deleteSource', () => {
    function dto(confirm: string): DeleteSourceDto {
      return { confirm };
    }

    it('refuses when no verification has run (409 VERIFY_HAS_GAPS)', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        migratedCount: 5,
      });
      lastVerification = null;
      const service = makeService();
      let caught: unknown;
      try {
        await service.deleteSource(
          'mig-1',
          dto('DELETE 5 documents from spaces-default'),
          ACTOR,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.code).toBe('VERIFY_HAS_GAPS');
    });

    it('refuses when the most recent verification has gaps', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        migratedCount: 5,
      });
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.COMPLETED_WITH_GAPS,
        verifiedCount: 4,
        missingAtDestination: 1,
        totalChecked: 5,
      } as unknown as StorageMigrationVerification;

      providersRepo.findOne.mockResolvedValueOnce(buildProviderRow('src'));

      const service = makeService();
      await expect(
        service.deleteSource(
          'mig-1',
          dto('DELETE 5 documents from spaces-default'),
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses with 400 when the confirmation phrase does not match exactly', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        migratedCount: 5,
      });
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.COMPLETED,
        verifiedCount: 5,
        missingAtDestination: 0,
        totalChecked: 5,
      } as unknown as StorageMigrationVerification;
      providersRepo.findOne.mockResolvedValueOnce(
        buildProviderRow('src', 'spaces-default'),
      );

      const service = makeService();
      let caught: unknown;
      try {
        await service.deleteSource(
          'mig-1',
          dto('delete 5 documents from spaces-default'), // lowercase typo
          ACTOR,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response.code).toBe('CONFIRM_MISMATCH');
    });

    it('happy path: deletes each source object, skips destination misses, sets sourceDeletedAt', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        migratedCount: 2,
      });
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.COMPLETED,
        verifiedCount: 2,
        missingAtDestination: 0,
        totalChecked: 2,
      } as unknown as StorageMigrationVerification;
      providersRepo.findOne.mockResolvedValueOnce(
        buildProviderRow('src', 'spaces-default'),
      );

      const docA = buildDoc({ id: 'doc-a', storageProviderId: 'dst' });
      const docB = buildDoc({ id: 'doc-b', storageProviderId: 'dst' });
      documentsRepo.find
        .mockResolvedValueOnce([docA, docB])
        .mockResolvedValueOnce([]);

      // Source adapter — exercises the delete; destination adapter has
      // docA present and docB missing (skip path).
      const fromDelete = jest.fn().mockResolvedValue(undefined);
      const fromAdapter = buildAdapter({
        providerId: 'src',
        delete: fromDelete,
      });
      const toAdapter = buildAdapter({
        providerId: 'dst',
        objectExists: jest
          .fn()
          .mockResolvedValueOnce(true) // doc-a still at dst
          .mockResolvedValueOnce(false), // doc-b vanished from dst
        generateViewUrl: jest.fn().mockResolvedValue('https://signed/'),
      });
      registry.get
        .mockResolvedValueOnce(fromAdapter)
        .mockResolvedValueOnce(toAdapter);

      const service = makeService();
      await service.deleteSource(
        'mig-1',
        dto(expectedConfirmPhrase(2, 'spaces-default')),
        ACTOR,
      );

      // doc-a deleted from source, doc-b skipped.
      expect(fromDelete).toHaveBeenCalledTimes(1);
      expect(fromDelete).toHaveBeenCalledWith(docA.fileKey);

      const statuses = savedDeletions.map((d) => d.status);
      expect(statuses).toContain(StorageMigrationDeletionStatus.DELETED);
      expect(statuses).toContain(
        StorageMigrationDeletionStatus.SKIPPED_MISSING_AT_DESTINATION,
      );
      expect(migrationRow.sourceDeletedAt).toBeInstanceOf(Date);
      expect(registry.invalidate).toHaveBeenCalledWith('src');
    });

    it('records FAILED when the source delete throws', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        migratedCount: 1,
      });
      lastVerification = {
        id: 'verif-1',
        migrationId: 'mig-1',
        status: StorageMigrationVerificationStatus.COMPLETED,
        verifiedCount: 1,
        missingAtDestination: 0,
        totalChecked: 1,
      } as unknown as StorageMigrationVerification;
      providersRepo.findOne.mockResolvedValueOnce(
        buildProviderRow('src', 'spaces-default'),
      );

      const docA = buildDoc({ id: 'doc-a', storageProviderId: 'dst' });
      documentsRepo.find
        .mockResolvedValueOnce([docA])
        .mockResolvedValueOnce([]);

      const fromAdapter = buildAdapter({
        providerId: 'src',
        delete: jest.fn().mockRejectedValue(new Error('access denied')),
      });
      const toAdapter = buildAdapter({
        providerId: 'dst',
        objectExists: jest.fn().mockResolvedValue(true),
        generateViewUrl: jest.fn().mockResolvedValue('https://signed/'),
      });
      registry.get
        .mockResolvedValueOnce(fromAdapter)
        .mockResolvedValueOnce(toAdapter);

      const service = makeService();
      await service.deleteSource(
        'mig-1',
        dto(expectedConfirmPhrase(1, 'spaces-default')),
        ACTOR,
      );

      expect(savedDeletions[0].status).toBe(
        StorageMigrationDeletionStatus.FAILED,
      );
      expect(savedDeletions[0].errorMessage).toMatch(/access denied/);
      // sourceDeletedAt is still set — the action ran to completion
      // even though one doc failed. The deletion row carries the
      // failure detail.
      expect(migrationRow.sourceDeletedAt).toBeInstanceOf(Date);
    });

    it('refuses to re-run delete on a migration that already has sourceDeletedAt', async () => {
      migrationRow = buildMigration({
        status: StorageMigrationStatus.COMPLETED,
        sourceDeletedAt: new Date(),
      });
      const service = makeService();
      await expect(
        service.deleteSource(
          'mig-1',
          dto('DELETE 0 documents from spaces-default'),
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
