import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { Document } from '../documents/entities/document.entity';
import { DeleteSourceDto } from './dto/delete-source.dto';
import { QueueStorageMigrationDto } from './dto/queue-storage-migration.dto';
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
import { StorageRegistry } from './storage-registry.service';

// STG-4 — implementation knobs.
const RETRY_BACKOFFS_MS = [1000, 4000, 16000];
const MAX_DOC_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 25;

export interface StorageMigrationFailureView {
  id: string;
  documentId: string;
  errorMessage: string;
  attempt: number;
  createdAt: string;
}

/**
 * STG-4 — single-threaded cross-provider document copy worker.
 *
 * One job runs at a time per process; a second `start()` while a job
 * is active returns 409. The worker walks docs in `id ASC` order in
 * batches, copies each via `srcAdapter.getStream → destAdapter.uploadBuffer`,
 * verifies destination existence, and flips `documents.storageProviderId`
 * in a per-doc transaction. A 50 MB hard cap on object size keeps the
 * in-process buffer copy from blowing memory.
 *
 * Pause/resume is cooperative — the worker checks for a pause request
 * between docs and exits cleanly after the in-flight copy finishes.
 * Resume uses `lastDocumentId` to skip already-migrated rows.
 */
@Injectable()
export class StorageMigrationService {
  private readonly logger = new Logger(StorageMigrationService.name);
  private currentMigrationId: string | null = null;
  private pauseRequested = false;
  private readonly verifyingMigrationIds = new Set<string>();
  private readonly deletingMigrationIds = new Set<string>();

  constructor(
    @InjectRepository(StorageMigration)
    private readonly migrationsRepo: Repository<StorageMigration>,
    @InjectRepository(StorageMigrationFailure)
    private readonly failuresRepo: Repository<StorageMigrationFailure>,
    @InjectRepository(StorageMigrationVerification)
    private readonly verificationsRepo: Repository<StorageMigrationVerification>,
    @InjectRepository(StorageMigrationDeletion)
    private readonly deletionsRepo: Repository<StorageMigrationDeletion>,
    @InjectRepository(StorageProvider)
    private readonly providersRepo: Repository<StorageProvider>,
    @InjectRepository(Document)
    private readonly documentsRepo: Repository<Document>,
    private readonly dataSource: DataSource,
    private readonly registry: StorageRegistry,
    private readonly approvals: ApprovalsService,
  ) {}

  async list(): Promise<StorageMigration[]> {
    return this.migrationsRepo.find({
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async findOne(id: string): Promise<StorageMigration> {
    const row = await this.migrationsRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Migration ${id} not found.`);
    return row;
  }

  async listFailures(
    migrationId: string,
  ): Promise<StorageMigrationFailureView[]> {
    await this.findOne(migrationId);
    const rows = await this.failuresRepo.find({
      where: { migrationId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      errorMessage: r.errorMessage,
      attempt: r.attempt,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Queue a migration + kick the in-process worker. Refuses with 409
   * if another job is already running in this process.
   */
  async start(
    dto: QueueStorageMigrationDto,
    actorUserId: string,
  ): Promise<StorageMigration> {
    if (this.currentMigrationId) {
      throw new ConflictException(
        `Another migration (${this.currentMigrationId}) is already running. Pause it before starting a new one.`,
      );
    }

    const [fromProvider, toProvider] = await Promise.all([
      this.providersRepo.findOne({ where: { id: dto.fromProviderId } }),
      this.providersRepo.findOne({ where: { id: dto.toProviderId } }),
    ]);
    if (!fromProvider) {
      throw new NotFoundException(
        `Source provider ${dto.fromProviderId} not found.`,
      );
    }
    if (!toProvider) {
      throw new NotFoundException(
        `Destination provider ${dto.toProviderId} not found.`,
      );
    }

    const queuedAt = new Date();
    const since = dto.since ? new Date(dto.since) : null;
    const total = await this.documentsRepo.count({
      where: {
        storageProviderId: dto.fromProviderId,
        createdAt: LessThanOrEqual(queuedAt),
        ...(since ? { createdAt: MoreThanOrEqual(since) } : {}),
      },
    });

    const migration = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(StorageMigration, {
        fromProviderId: dto.fromProviderId,
        toProviderId: dto.toProviderId,
        dryRun: dto.dryRun ?? false,
        batchSize: dto.batchSize ?? DEFAULT_BATCH_SIZE,
        since,
        queuedAt,
        queuedUntilCreatedAt: queuedAt,
        totalDocuments: total,
        status: StorageMigrationStatus.QUEUED,
        startedBy: actorUserId,
      });
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_MIGRATION,
        targetId: created.id,
        action: ApprovalAction.CREATE,
        reviewerId: actorUserId,
        reason: `Queued migration ${fromProvider.slug} → ${toProvider.slug} (dryRun=${created.dryRun}, total=${total})`,
      });
      return created;
    });

    this.currentMigrationId = migration.id;
    this.pauseRequested = false;
    // Kick the loop on the next tick so the HTTP response returns
    // promptly. Any uncaught loop error transitions the migration to
    // 'completed_with_errors' with the message persisted.
    setImmediate(() => {
      void this.runLoop(migration.id).catch((err) => {
        this.logger.error(
          `Migration ${migration.id} loop crashed: ${(err as Error).message}`,
        );
      });
    });

    return migration;
  }

  async pause(id: string, actorUserId: string): Promise<StorageMigration> {
    if (this.currentMigrationId !== id) {
      throw new ConflictException(
        `Migration ${id} is not currently running in this process.`,
      );
    }
    this.pauseRequested = true;
    await this.approvals.recordDecision(this.dataSource.manager, {
      targetType: ApprovalTargetType.STORAGE_MIGRATION,
      targetId: id,
      action: ApprovalAction.PAUSE,
      reviewerId: actorUserId,
      reason: 'Pause requested',
    });
    return this.findOne(id);
  }

  async resume(id: string, actorUserId: string): Promise<StorageMigration> {
    if (this.currentMigrationId) {
      throw new ConflictException(
        `Another migration (${this.currentMigrationId}) is already running. Pause it before resuming.`,
      );
    }
    const row = await this.findOne(id);
    if (row.status !== StorageMigrationStatus.PAUSED) {
      throw new ConflictException(
        `Migration ${id} is not paused (current status: ${row.status}).`,
      );
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        StorageMigration,
        { id },
        { status: StorageMigrationStatus.QUEUED },
      );
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_MIGRATION,
        targetId: id,
        action: ApprovalAction.RESUME,
        reviewerId: actorUserId,
        reason: 'Resume requested',
      });
    });
    this.currentMigrationId = id;
    this.pauseRequested = false;
    setImmediate(() => {
      void this.runLoop(id).catch((err) => {
        this.logger.error(
          `Migration ${id} loop crashed: ${(err as Error).message}`,
        );
      });
    });
    return this.findOne(id);
  }

  /**
   * The actual worker — exposed as a public method so tests can drive
   * it synchronously without setImmediate scheduling. Production
   * callers should NOT invoke this directly; use start/resume.
   */
  async runLoop(migrationId: string): Promise<void> {
    const row = await this.migrationsRepo.findOne({
      where: { id: migrationId },
    });
    if (!row) {
      this.currentMigrationId = null;
      return;
    }

    try {
      await this.migrationsRepo.update(
        { id: migrationId },
        {
          status: StorageMigrationStatus.RUNNING,
          startedAt: row.startedAt ?? new Date(),
        },
      );

      const fromAdapter = await this.registry.get(row.fromProviderId);
      const toAdapter = await this.registry.get(row.toProviderId);

      let cursor: string | null = row.lastDocumentId;

      while (true) {
        if (this.pauseRequested) {
          await this.migrationsRepo.update(
            { id: migrationId },
            { status: StorageMigrationStatus.PAUSED },
          );
          this.logger.log(
            `Migration ${migrationId} paused after ${row.migratedCount} docs`,
          );
          return;
        }

        const batch = await this.fetchBatch(row, cursor);
        if (batch.length === 0) break;

        for (const doc of batch) {
          if (this.pauseRequested) {
            await this.migrationsRepo.update(
              { id: migrationId },
              { status: StorageMigrationStatus.PAUSED },
            );
            return;
          }
          await this.processDocument(row, doc, fromAdapter, toAdapter);
          cursor = doc.id;
        }
      }

      // Reload the latest counters; the loop has been writing them
      // through `processDocument`. Final status hinges on failedCount.
      const refreshed = await this.migrationsRepo.findOne({
        where: { id: migrationId },
      });
      const finalStatus =
        (refreshed?.failedCount ?? 0) > 0
          ? StorageMigrationStatus.COMPLETED_WITH_ERRORS
          : StorageMigrationStatus.COMPLETED;
      await this.migrationsRepo.update(
        { id: migrationId },
        {
          status: finalStatus,
          finishedAt: new Date(),
        },
      );
      this.logger.log(
        `Migration ${migrationId} ${finalStatus}: migrated=${refreshed?.migratedCount} failed=${refreshed?.failedCount}`,
      );
    } catch (err) {
      // Loop-level error (e.g. credential decrypt failed mid-flight).
      // Surface it as completed_with_errors so the UI surfaces it
      // explicitly instead of silently freezing in 'running'.
      await this.migrationsRepo.update(
        { id: migrationId },
        {
          status: StorageMigrationStatus.COMPLETED_WITH_ERRORS,
          finishedAt: new Date(),
          errorMessage: sanitiseError(err),
        },
      );
    } finally {
      if (this.currentMigrationId === migrationId) {
        this.currentMigrationId = null;
      }
    }
  }

  private async fetchBatch(
    row: StorageMigration,
    cursor: string | null,
  ): Promise<Document[]> {
    const where: Record<string, unknown> = {
      storageProviderId: row.fromProviderId,
      createdAt: LessThanOrEqual(row.queuedUntilCreatedAt),
    };
    if (row.since) {
      // TypeORM doesn't combine two ranges on the same column out of
      // the box; the explicit `LessThanOrEqual` above is wrapped here
      // using a Raw clause via `Between` instead would muddy the query
      // builder. Instead, fall back to an inline manager.query string
      // for clarity.
      const idCondition = cursor ? 'AND "id" > $4' : '';
      const params: unknown[] = [
        row.fromProviderId,
        row.queuedUntilCreatedAt,
        row.since,
      ];
      if (cursor) params.push(cursor);
      return this.documentsRepo.query(
        `SELECT * FROM "documents"
         WHERE "storageProviderId" = $1
           AND "createdAt" <= $2
           AND "createdAt" >= $3
           ${idCondition}
         ORDER BY "id" ASC
         LIMIT ${row.batchSize}`,
        params,
      );
    }
    if (cursor) where.id = MoreThan(cursor);
    return this.documentsRepo.find({
      where,
      order: { id: 'ASC' },
      take: row.batchSize,
    });
  }

  private async processDocument(
    migration: StorageMigration,
    doc: Document,
    fromAdapter: StorageAdapter,
    toAdapter: StorageAdapter,
  ): Promise<void> {
    if (!doc.fileKey) {
      // Pre-C1 placeholder rows have no fileKey to migrate. Count as
      // skipped and move on.
      await this.migrationsRepo.increment(
        { id: migration.id },
        'skippedCount',
        1,
      );
      await this.migrationsRepo.update(
        { id: migration.id },
        { lastDocumentId: doc.id },
      );
      return;
    }

    if (migration.dryRun) {
      try {
        const exists = await fromAdapter.objectExists(doc.fileKey);
        if (!exists) {
          await this.recordFailure(
            migration.id,
            doc.id,
            1,
            `Source object missing: ${doc.fileKey}`,
          );
          return;
        }
        await this.migrationsRepo.increment(
          { id: migration.id },
          'wouldMigrateCount',
          1,
        );
      } catch (err) {
        await this.recordFailure(migration.id, doc.id, 1, sanitiseError(err));
      }
      await this.migrationsRepo.update(
        { id: migration.id },
        { lastDocumentId: doc.id },
      );
      return;
    }

    let attempt = 0;
    let lastError: unknown;
    while (attempt < RETRY_BACKOFFS_MS.length + 1) {
      attempt += 1;
      try {
        await this.copyDocument(doc, fromAdapter, toAdapter);
        await this.dataSource.transaction(async (manager) => {
          await manager.update(
            Document,
            { id: doc.id },
            {
              storageProviderId: migration.toProviderId,
              fileUrl: toAdapter.canonicalUri(doc.fileKey as string),
            },
          );
          await manager.increment(
            StorageMigration,
            { id: migration.id },
            'migratedCount',
            1,
          );
          await manager.update(
            StorageMigration,
            { id: migration.id },
            { lastDocumentId: doc.id },
          );
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt > RETRY_BACKOFFS_MS.length) break;
        await sleep(RETRY_BACKOFFS_MS[attempt - 1]);
      }
    }

    await this.recordFailure(
      migration.id,
      doc.id,
      attempt,
      sanitiseError(lastError),
    );
    await this.migrationsRepo.update(
      { id: migration.id },
      { lastDocumentId: doc.id },
    );
  }

  private async copyDocument(
    doc: Document,
    fromAdapter: StorageAdapter,
    toAdapter: StorageAdapter,
  ): Promise<void> {
    if (!doc.fileKey) throw new Error('Document has no fileKey');
    const stream = await fromAdapter.getStream(doc.fileKey);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_DOC_SIZE_BYTES) {
        throw new Error(
          `Document ${doc.id} exceeds the 50 MB per-document cap (${size} bytes streamed before stop). Larger objects will need a streaming PUT — out of scope for STG-4.`,
        );
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    const contentType = inferContentType(doc.fileKey);
    await toAdapter.uploadBuffer(doc.fileKey, body, contentType);
    const verified = await toAdapter.objectExists(doc.fileKey);
    if (!verified) {
      throw new Error(
        `Destination verification failed: ${doc.fileKey} not present after upload.`,
      );
    }
  }

  private async recordFailure(
    migrationId: string,
    documentId: string,
    attempt: number,
    message: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.save(StorageMigrationFailure, {
        migrationId,
        documentId,
        attempt,
        errorMessage: message,
      });
      await manager.increment(
        StorageMigration,
        { id: migrationId },
        'failedCount',
        1,
      );
    });
  }

  // STG-5 ─────────────────────────────────────────────────────────────────────

  /**
   * Kick a verify pass against a finished migration. Refuses with 409
   * if the migration is still running OR if another verify is already
   * in flight for this migration in the same process.
   */
  async verify(
    migrationId: string,
    actorUserId: string,
  ): Promise<StorageMigrationVerification> {
    const migration = await this.findOne(migrationId);
    if (
      migration.status !== StorageMigrationStatus.COMPLETED &&
      migration.status !== StorageMigrationStatus.COMPLETED_WITH_ERRORS
    ) {
      throw new ConflictException(
        `Migration ${migrationId} is not in a verifiable state (current status: ${migration.status}). Verify is available after the migration finishes.`,
      );
    }
    if (this.verifyingMigrationIds.has(migrationId)) {
      throw new ConflictException({
        code: 'VERIFY_ALREADY_RUNNING',
        message: `A verify pass for migration ${migrationId} is already running.`,
      });
    }

    const verification = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(StorageMigrationVerification, {
        migrationId,
        status: StorageMigrationVerificationStatus.RUNNING,
        startedAt: new Date(),
      });
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_MIGRATION,
        targetId: migrationId,
        action: ApprovalAction.CREATE,
        reviewerId: actorUserId,
        reason: `Verify pass started for migration ${migrationId}`,
      });
      return created;
    });

    this.verifyingMigrationIds.add(migrationId);
    setImmediate(() => {
      void this.runVerifyLoop(verification.id, migration).catch((err) => {
        this.logger.error(
          `Verify ${verification.id} crashed: ${(err as Error).message}`,
        );
      });
    });
    return verification;
  }

  async latestVerification(
    migrationId: string,
  ): Promise<StorageMigrationVerification | null> {
    return this.verificationsRepo.findOne({
      where: { migrationId },
      order: { startedAt: 'DESC' },
    });
  }

  async listVerifications(
    migrationId: string,
  ): Promise<StorageMigrationVerification[]> {
    return this.verificationsRepo.find({
      where: { migrationId },
      order: { startedAt: 'DESC' },
    });
  }

  /**
   * Verify loop — public for tests; production callers use `verify()`.
   * Walks every document whose `storageProviderId === toProviderId` and
   * `createdAt <= queuedUntilCreatedAt`. For each:
   *   - `objectExists(key)` on the destination adapter
   *   - `generateViewUrl(key)` — exercises the URL-signing pipeline;
   *     a throw is treated as a gap
   * A document is counted as verified only if BOTH checks succeed.
   */
  async runVerifyLoop(
    verificationId: string,
    migration: StorageMigration,
  ): Promise<void> {
    try {
      const toAdapter = await this.registry.get(migration.toProviderId);
      const cursorIter = this.iterateMigratedDocs(migration);
      let verified = 0;
      let missing = 0;
      let total = 0;
      for await (const doc of cursorIter) {
        total += 1;
        const isMissing = await this.isMissingAtDestination(doc, toAdapter);
        if (isMissing) {
          missing += 1;
        } else {
          verified += 1;
        }
        await this.verificationsRepo.update(
          { id: verificationId },
          {
            verifiedCount: verified,
            missingAtDestination: missing,
            totalChecked: total,
          },
        );
      }
      const finalStatus =
        missing > 0
          ? StorageMigrationVerificationStatus.COMPLETED_WITH_GAPS
          : StorageMigrationVerificationStatus.COMPLETED;
      await this.verificationsRepo.update(
        { id: verificationId },
        { status: finalStatus, finishedAt: new Date() },
      );
      this.logger.log(
        `Verify ${verificationId} ${finalStatus}: verified=${verified} missing=${missing}`,
      );
    } catch (err) {
      this.logger.error(
        `Verify ${verificationId} loop crashed: ${(err as Error).message}`,
      );
      await this.verificationsRepo.update(
        { id: verificationId },
        {
          status: StorageMigrationVerificationStatus.COMPLETED_WITH_GAPS,
          finishedAt: new Date(),
        },
      );
    } finally {
      this.verifyingMigrationIds.delete(migration.id);
    }
  }

  /**
   * STG-5 — explicit source-delete. Requires:
   *   1. A latest verification with zero gaps.
   *   2. An exact-match confirmation phrase (compared server-side).
   * Re-verifies destination existence per doc; missing → skipped.
   */
  async deleteSource(
    migrationId: string,
    dto: DeleteSourceDto,
    actorUserId: string,
  ): Promise<StorageMigration> {
    if (this.deletingMigrationIds.has(migrationId)) {
      throw new ConflictException(
        `A source-delete for migration ${migrationId} is already running.`,
      );
    }
    const migration = await this.findOne(migrationId);
    if (migration.sourceDeletedAt) {
      throw new ConflictException(
        `Source for migration ${migrationId} has already been deleted.`,
      );
    }

    const verification = await this.latestVerification(migrationId);
    if (
      !verification ||
      verification.status !== StorageMigrationVerificationStatus.COMPLETED
    ) {
      throw new ConflictException({
        code: 'VERIFY_HAS_GAPS',
        missing: verification?.missingAtDestination ?? 0,
        message:
          'Source delete requires the latest verify pass to have completed with zero gaps. Run a fresh verify.',
      });
    }

    const sourceProvider = await this.providersRepo.findOne({
      where: { id: migration.fromProviderId },
    });
    if (!sourceProvider) {
      throw new NotFoundException(
        `Source provider ${migration.fromProviderId} no longer exists.`,
      );
    }
    const expected = expectedConfirmPhrase(
      migration.migratedCount,
      sourceProvider.slug,
    );
    if (dto.confirm !== expected) {
      throw new BadRequestException({
        code: 'CONFIRM_MISMATCH',
        message: `Confirmation phrase does not match. Expected exactly: "${expected}".`,
      });
    }

    this.deletingMigrationIds.add(migrationId);
    try {
      await this.approvals.recordDecision(this.dataSource.manager, {
        targetType: ApprovalTargetType.STORAGE_MIGRATION,
        targetId: migrationId,
        action: ApprovalAction.DELETE,
        reviewerId: actorUserId,
        reason: `Source-delete started for migration ${migrationId}`,
      });

      const [fromAdapter, toAdapter] = await Promise.all([
        this.registry.get(migration.fromProviderId),
        this.registry.get(migration.toProviderId),
      ]);

      for await (const doc of this.iterateMigratedDocs(migration)) {
        if (!doc.fileKey) {
          continue;
        }
        const stillThere = await this.isMissingAtDestination(doc, toAdapter);
        if (stillThere) {
          await this.deletionsRepo.save({
            migrationId,
            documentId: doc.id,
            status:
              StorageMigrationDeletionStatus.SKIPPED_MISSING_AT_DESTINATION,
            errorMessage: null,
          });
          continue;
        }
        try {
          await fromAdapter.delete(doc.fileKey);
          await this.deletionsRepo.save({
            migrationId,
            documentId: doc.id,
            status: StorageMigrationDeletionStatus.DELETED,
            errorMessage: null,
          });
        } catch (err) {
          await this.deletionsRepo.save({
            migrationId,
            documentId: doc.id,
            status: StorageMigrationDeletionStatus.FAILED,
            errorMessage: sanitiseError(err),
          });
        }
      }

      await this.migrationsRepo.update(
        { id: migrationId },
        { sourceDeletedAt: new Date() },
      );
      // Flush any cached adapter for the source provider — if the
      // operator immediately rotates credentials post-delete, the next
      // adapter build should decrypt the fresh secret.
      this.registry.invalidate(migration.fromProviderId);

      await this.approvals.recordDecision(this.dataSource.manager, {
        targetType: ApprovalTargetType.STORAGE_MIGRATION,
        targetId: migrationId,
        action: ApprovalAction.DELETE,
        reviewerId: actorUserId,
        reason: `Source-delete completed for migration ${migrationId}`,
      });
    } finally {
      this.deletingMigrationIds.delete(migrationId);
    }

    return this.findOne(migrationId);
  }

  async listDeletions(
    migrationId: string,
  ): Promise<StorageMigrationDeletion[]> {
    return this.deletionsRepo.find({
      where: { migrationId },
      order: { deletedAt: 'ASC' },
    });
  }

  // STG-5 helpers ────────────────────────────────────────────────────────────

  /**
   * Walk every document the migration moved. The "moved" set is the
   * intersection of `storageProviderId === toProviderId` and
   * `createdAt <= queuedUntilCreatedAt` — same anchor used during the
   * copy phase.
   */
  private async *iterateMigratedDocs(
    migration: StorageMigration,
  ): AsyncGenerator<Document> {
    const pageSize = 100;
    let cursor: string | null = null;
    while (true) {
      const where: Record<string, unknown> = {
        storageProviderId: migration.toProviderId,
        createdAt: LessThanOrEqual(migration.queuedUntilCreatedAt),
      };
      if (cursor) where.id = MoreThan(cursor);
      const batch = await this.documentsRepo.find({
        where,
        order: { id: 'ASC' },
        take: pageSize,
      });
      if (batch.length === 0) return;
      for (const doc of batch) {
        cursor = doc.id;
        yield doc;
      }
    }
  }

  private async isMissingAtDestination(
    doc: Document,
    toAdapter: StorageAdapter,
  ): Promise<boolean> {
    if (!doc.fileKey) return true;
    try {
      const exists = await toAdapter.objectExists(doc.fileKey);
      if (!exists) return true;
      // Exercise the signed-URL pipeline — if signing fails, we treat
      // the doc as effectively unreachable from the destination side.
      await toAdapter.generateViewUrl(doc.fileKey);
      return false;
    } catch {
      return true;
    }
  }
}

export function expectedConfirmPhrase(
  migratedCount: number,
  sourceSlug: string,
): string {
  return `DELETE ${migratedCount} documents from ${sourceSlug}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitiseError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.slice(0, 500);
  }
  return String(err).slice(0, 500);
}

function inferContentType(fileKey: string): string {
  const lower = fileKey.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}
