import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemConfigService } from '../config/config.service';
import { S3CompatibleAdapter } from './adapters/s3-compatible.adapter';
import { StorageCryptoService } from './crypto.service';
import {
  StorageProvider,
  StorageProviderKind,
} from './entities/storage-provider.entity';
import type { StorageAdapter } from './storage-adapter.interface';

const ACTIVE_PROVIDER_KEY = 'storage.activeProviderId';

// STG-3 — LRU + TTL cache parameters. The hot path is a single
// indexed DB read + an AES-256-GCM decrypt + an S3Client construction;
// the cache avoids the decrypt/construct on every call. The cache key
// embeds `updatedAt`, so an admin credential rotation in this process
// (or any other process that wrote the row to the DB after our cache
// entry was created) naturally produces a different key on the next
// lookup — the stale entry simply waits for LRU eviction.
const CACHE_MAX_ENTRIES = 16;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedAdapter {
  adapter: StorageAdapter;
  insertedAt: number;
}

/**
 * STG-1 + STG-3 — lookup-by-id / lookup-active facade over
 * `storage_providers`, backed by an in-process LRU+TTL cache so the
 * decrypt + S3Client construction don't run on every upload-url call.
 *
 * Admin-write paths (StorageProvidersService.update / remove / activate)
 * call `invalidate(id)` after their transaction commits to flush any
 * cached adapters that were built before the write.
 */
@Injectable()
export class StorageRegistry implements OnModuleInit {
  private readonly logger = new Logger(StorageRegistry.name);
  // Map preserves insertion order in JS — used as a simple LRU.
  private readonly cache = new Map<string, CachedAdapter>();

  constructor(
    @InjectRepository(StorageProvider)
    private readonly repo: Repository<StorageProvider>,
    private readonly config: SystemConfigService,
    private readonly crypto: StorageCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Diagnostic: surface the active provider slug on boot so logs
    // make it obvious which bucket new uploads will land in.
    try {
      const activeId = await this.config.get<string | null>(
        ACTIVE_PROVIDER_KEY,
        null,
      );
      if (!activeId) {
        this.logger.warn(
          'No active storage provider configured. system_configs.storage.activeProviderId is unset; upload-url calls will throw until it is seeded (run pending DB migrations).',
        );
        return;
      }
      const row = await this.repo.findOne({ where: { id: activeId } });
      if (!row) {
        this.logger.error(
          `system_configs.storage.activeProviderId points to ${activeId}, but no matching storage_providers row exists. Inserts will fail until this is reconciled.`,
        );
        return;
      }
      this.logger.log(
        `Active storage provider: ${row.slug} (${row.displayName}) — bucket=${row.bucket}, endpoint=${row.endpoint}`,
      );
    } catch (err) {
      this.logger.error(
        `StorageRegistry boot probe failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve the adapter for the active provider. Used for new uploads.
   * Throws if no active provider is configured (a serious deployment
   * misconfiguration — the bootstrap migration should always seed one).
   */
  async getActive(): Promise<StorageAdapter> {
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    if (!activeId) {
      throw new NotFoundException(
        'No active storage provider configured. Run pending DB migrations or set system_configs.storage.activeProviderId.',
      );
    }
    return this.get(activeId);
  }

  /**
   * Resolve the adapter for a specific provider id. Used when reading
   * an existing document — the document's `storageProviderId` column
   * names the provider, not the active one (which may have changed
   * since the document was uploaded).
   */
  async get(providerId: string): Promise<StorageAdapter> {
    const row = await this.repo.findOne({ where: { id: providerId } });
    if (!row) {
      throw new NotFoundException(`Storage provider ${providerId} not found.`);
    }
    if (!row.enabled) {
      throw new NotFoundException(
        `Storage provider ${row.slug} is disabled. Re-enable it in admin → storage settings to read its documents.`,
      );
    }
    const cacheKey = `${row.id}:${row.updatedAt.toISOString()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.insertedAt < CACHE_TTL_MS) {
      // Refresh LRU position: delete + re-insert so a hot adapter
      // stays at the tail and won't be evicted under pressure.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return hit.adapter;
    }
    if (hit) {
      // Stale — drop it before we rebuild.
      this.cache.delete(cacheKey);
    }
    const adapter = this.build(row);
    this.cache.set(cacheKey, { adapter, insertedAt: Date.now() });
    this.enforceLruCap();
    return adapter;
  }

  /**
   * Flush every cached adapter built from a given provider row. Called
   * by `StorageProvidersService` after a successful update / delete /
   * activate so subsequent lookups within the cache TTL pick up the
   * new credentials immediately rather than waiting for natural
   * `updatedAt` drift.
   */
  invalidate(providerId: string): void {
    const prefix = `${providerId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Test seam — admin Test endpoint touches this to keep the cache fresh. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Test seam. */
  cacheSize(): number {
    return this.cache.size;
  }

  private build(row: StorageProvider): StorageAdapter {
    switch (row.kind) {
      case StorageProviderKind.S3_COMPATIBLE: {
        const secretAccessKey = this.crypto.decryptSecret({
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
          secretAccessKey,
        });
      }
      default: {
        const exhaustive: never = row.kind;
        throw new Error(
          `Unsupported storage provider kind: ${String(exhaustive)}`,
        );
      }
    }
  }

  private enforceLruCap(): void {
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const iter = this.cache.keys().next();
      if (iter.done) return;
      this.cache.delete(iter.value);
    }
  }
}
