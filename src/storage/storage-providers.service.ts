import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
import { CreateStorageProviderDto } from './dto/create-storage-provider.dto';
import { UpdateStorageProviderDto } from './dto/update-storage-provider.dto';
import {
  StorageProvider,
  StorageProviderKind,
} from './entities/storage-provider.entity';
import { StorageRegistry } from './storage-registry.service';

const ACTIVE_PROVIDER_KEY = 'storage.activeProviderId';

export interface StorageProviderView {
  id: string;
  slug: string;
  kind: StorageProviderKind;
  displayName: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: {
    masked: string;
    updatedAt: string;
  };
  enabled: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StorageProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * STG-2 — admin-facing CRUD for `storage_providers`. The service owns
 * the encryption-at-rest invariants (secret never echoed back, every
 * write encrypted via `StorageCryptoService`) + the audit-log writes
 * that mirror each mutation into `approval_decisions`.
 *
 * STG-3 layers an in-memory adapter cache on top of `StorageRegistry`;
 * to keep that wiring simple, every write here will explicitly notify
 * the registry once that lands. For STG-2 the registry has no cache
 * yet, so the writes are fire-and-forget against the DB.
 */
@Injectable()
export class StorageProvidersService {
  private readonly logger = new Logger(StorageProvidersService.name);

  constructor(
    @InjectRepository(StorageProvider)
    private readonly repo: Repository<StorageProvider>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    private readonly dataSource: DataSource,
    private readonly crypto: StorageCryptoService,
    private readonly config: SystemConfigService,
    private readonly approvals: ApprovalsService,
    private readonly registry: StorageRegistry,
  ) {}

  async list(): Promise<StorageProviderView[]> {
    const [rows, activeId] = await Promise.all([
      this.repo.find({ order: { displayName: 'ASC' } }),
      this.activeProviderId(),
    ]);
    return rows.map((row) => this.toView(row, activeId));
  }

  async findOne(id: string): Promise<StorageProviderView> {
    const row = await this.requireRow(id);
    return this.toView(row, await this.activeProviderId());
  }

  async create(
    dto: CreateStorageProviderDto,
    actorUserId: string,
  ): Promise<StorageProviderView> {
    // Pre-check the slug to give a friendly 409 instead of a Postgres
    // unique-violation surfaced as a 500.
    const existing = await this.repo.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException(
        `Storage provider slug "${dto.slug}" is already in use.`,
      );
    }

    const encrypted = this.crypto.encryptSecret(dto.secretAccessKey);

    const created = await this.dataSource.transaction(async (manager) => {
      const inserted = await manager.save(StorageProvider, {
        slug: dto.slug,
        kind: dto.kind ?? StorageProviderKind.S3_COMPATIBLE,
        displayName: dto.displayName,
        endpoint: dto.endpoint,
        region: dto.region,
        bucket: dto.bucket,
        accessKeyId: dto.accessKeyId,
        secretCipher: encrypted.cipher,
        secretNonce: encrypted.nonce,
        secretTag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
        enabled: true,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_PROVIDER,
        targetId: inserted.id,
        action: ApprovalAction.CREATE,
        reviewerId: actorUserId,
        reason: `Created storage provider "${inserted.slug}" (${inserted.kind}, bucket=${inserted.bucket})`,
      });
      return inserted;
    });

    this.logger.log(
      `Created storage provider ${created.slug} (id=${created.id})`,
    );
    return this.toView(created, await this.activeProviderId());
  }

  async update(
    id: string,
    dto: UpdateStorageProviderDto,
    actorUserId: string,
  ): Promise<StorageProviderView> {
    const row = await this.requireRow(id);

    const changedFields: string[] = [];
    if (dto.displayName !== undefined && dto.displayName !== row.displayName) {
      row.displayName = dto.displayName;
      changedFields.push('displayName');
    }
    if (dto.endpoint !== undefined && dto.endpoint !== row.endpoint) {
      row.endpoint = dto.endpoint;
      changedFields.push('endpoint');
    }
    if (dto.region !== undefined && dto.region !== row.region) {
      row.region = dto.region;
      changedFields.push('region');
    }
    if (dto.bucket !== undefined && dto.bucket !== row.bucket) {
      row.bucket = dto.bucket;
      changedFields.push('bucket');
    }
    if (dto.accessKeyId !== undefined && dto.accessKeyId !== row.accessKeyId) {
      row.accessKeyId = dto.accessKeyId;
      changedFields.push('accessKeyId');
    }
    if (dto.secretAccessKey !== undefined) {
      const encrypted = this.crypto.encryptSecret(dto.secretAccessKey);
      row.secretCipher = encrypted.cipher;
      row.secretNonce = encrypted.nonce;
      row.secretTag = encrypted.tag;
      row.keyVersion = encrypted.keyVersion;
      changedFields.push('secretAccessKey');
    }
    if (dto.enabled !== undefined && dto.enabled !== row.enabled) {
      row.enabled = dto.enabled;
      changedFields.push('enabled');
    }

    if (changedFields.length === 0) {
      // Idempotent no-op PATCH — return the current view without
      // bumping updatedAt or writing an audit row.
      return this.toView(row, await this.activeProviderId());
    }

    row.updatedBy = actorUserId;

    const saved = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.save(StorageProvider, row);
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_PROVIDER,
        targetId: persisted.id,
        action: ApprovalAction.UPDATE,
        reviewerId: actorUserId,
        reason: `Updated fields: ${changedFields.join(', ')}`,
      });
      return persisted;
    });

    // STG-3 — flush any cached adapters built from the prior row state
    // so the next lookup decrypts the new secret + builds a fresh
    // S3Client. Cheap (sync map walk) and idempotent.
    this.registry.invalidate(id);

    return this.toView(saved, await this.activeProviderId());
  }

  async remove(id: string, actorUserId: string): Promise<void> {
    const row = await this.requireRow(id);

    const activeId = await this.activeProviderId();
    if (activeId === id) {
      throw new ConflictException({
        code: 'STORAGE_PROVIDER_IN_USE',
        isActive: true,
        referencedBy: 0,
        message:
          'This provider is currently active. Activate a different provider before deleting it.',
      });
    }

    const referencedBy = await this.documentRepo.count({
      where: { storageProviderId: id },
    });
    if (referencedBy > 0) {
      throw new ConflictException({
        code: 'STORAGE_PROVIDER_IN_USE',
        isActive: false,
        referencedBy,
        message: `Cannot delete: ${referencedBy} document(s) still reference this provider. Migrate them to a different provider first.`,
      });
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(StorageProvider, { id: row.id });
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_PROVIDER,
        targetId: row.id,
        action: ApprovalAction.DELETE,
        reviewerId: actorUserId,
        reason: `Deleted storage provider "${row.slug}"`,
      });
    });

    this.registry.invalidate(row.id);
    this.logger.log(`Deleted storage provider ${row.slug} (id=${row.id})`);
  }

  /**
   * STG-2 test endpoint — build an adapter from the row, call
   * `objectExists` against a sentinel key, return latency on success
   * or a friendly error on failure. The probe key may or may not
   * exist in the bucket — both 200 and 404 prove the credentials
   * work; only auth/network errors surface as `ok: false`.
   */
  async test(id: string): Promise<StorageProviderTestResult> {
    const row = await this.requireRow(id);
    const adapter = this.buildAdapter(row);
    const probeKey = '__healthcheck/__sentinel__';
    const startedAt = Date.now();
    try {
      await adapter.objectExists(probeKey);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      // Sanitise — never echo any secret material the SDK might
      // have wrapped into the error chain.
      const name = (err as { name?: string }).name ?? 'Error';
      const code =
        (err as { Code?: string; code?: string }).Code ??
        (err as { code?: string }).code;
      const message = describeAdapterError(err);
      return {
        ok: false,
        error: code ? `${name} (${code}): ${message}` : `${name}: ${message}`,
      };
    }
  }

  async activate(
    id: string,
    actorUserId: string,
  ): Promise<StorageProviderView> {
    const row = await this.requireRow(id);
    if (!row.enabled) {
      throw new BadRequestException(
        `Cannot activate a disabled provider. Enable "${row.slug}" first.`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      // SystemConfigService.update() doesn't accept an EntityManager,
      // so we drive the upsert by hand to keep it inside the same
      // transaction as the audit-log write.
      await manager.query(
        `INSERT INTO "system_configs" ("key", "value", "description", "dataType")
         VALUES ($1, $2, $3, 'string')
         ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
        [
          ACTIVE_PROVIDER_KEY,
          id,
          'STG-1 — id of the storage_providers row that new uploads are routed to.',
        ],
      );
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.STORAGE_PROVIDER,
        targetId: id,
        action: ApprovalAction.ACTIVATE,
        reviewerId: actorUserId,
        reason: `Activated storage provider "${row.slug}"`,
      });
    });
    // Refresh the in-memory config cache so the next getActive() sees
    // the new active provider id, and flush any cached adapter for it
    // (activation may have followed a credential edit that this process
    // didn't observe).
    await this.config.refreshCache();
    this.registry.invalidate(id);
    this.logger.log(
      `Activated storage provider ${row.slug} (id=${row.id}) — new uploads will land here`,
    );
    return this.toView(row, id);
  }

  private async requireRow(id: string): Promise<StorageProvider> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Storage provider ${id} not found.`);
    }
    return row;
  }

  private async activeProviderId(): Promise<string | null> {
    return this.config.get<string | null>(ACTIVE_PROVIDER_KEY, null);
  }

  private toView(
    row: StorageProvider,
    activeId: string | null,
  ): StorageProviderView {
    // Decrypt → mask trailing → never persist or return the plaintext.
    // If decrypt fails (key rotation gone wrong) we still render the
    // row but flag the secret as inaccessible so the operator knows.
    let masked: string;
    try {
      const plain = this.crypto.decryptSecret({
        cipher: row.secretCipher,
        nonce: row.secretNonce,
        tag: row.secretTag,
        keyVersion: row.keyVersion,
      });
      masked = this.crypto.maskTrailing(plain);
    } catch {
      masked = '••••••<decrypt failed>';
    }
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      displayName: row.displayName,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.accessKeyId,
      secretAccessKey: {
        masked,
        updatedAt: row.updatedAt.toISOString(),
      },
      enabled: row.enabled,
      isActive: activeId === row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private buildAdapter(row: StorageProvider): S3CompatibleAdapter {
    const secret = this.crypto.decryptSecret({
      cipher: row.secretCipher,
      nonce: row.secretNonce,
      tag: row.secretTag,
      keyVersion: row.keyVersion,
    });
    return new S3CompatibleAdapter({
      providerId: row.id,
      providerSlug: row.slug,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.accessKeyId,
      secretAccessKey: secret,
    });
  }
}

function describeAdapterError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
      .replace(/secretAccessKey=[^\s]+/gi, 'secretAccessKey=<redacted>')
      .slice(0, 240);
  }
  return String(err).slice(0, 240);
}
