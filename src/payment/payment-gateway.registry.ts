import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemConfigService } from '../config/config.service';
import { StorageCryptoService } from '../storage/crypto.service';
import {
  PaymentProvider,
  PaymentProviderKind,
} from './entities/payment-provider.entity';
import { PaystackGateway } from './gateways/paystack.gateway';
import type { IPaymentGateway } from './interfaces/payment-gateway.interface';

const ACTIVE_PROVIDER_KEY = 'payment.activeProviderId';

// Cache parameters mirror StorageRegistry. Hot path is a single
// indexed DB read + AES-256-GCM decrypt + gateway construction.
const CACHE_MAX_ENTRIES = 8;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedGateway {
  gateway: IPaymentGateway;
  insertedAt: number;
}

/**
 * PAY-1 — lookup-by-id / lookup-active facade over `payment_providers`.
 * The cache key embeds `updatedAt` so an admin credential rotation
 * naturally produces a new key on the next lookup; the stale entry
 * waits for LRU eviction. Admin-write paths call `invalidate(id)`
 * after their transaction commits to flush built gateways
 * immediately.
 */
@Injectable()
export class PaymentGatewayRegistry implements OnModuleInit {
  private readonly logger = new Logger(PaymentGatewayRegistry.name);
  private readonly cache = new Map<string, CachedGateway>();

  constructor(
    @InjectRepository(PaymentProvider)
    private readonly repo: Repository<PaymentProvider>,
    private readonly config: SystemConfigService,
    private readonly crypto: StorageCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const activeId = await this.config.get<string | null>(
        ACTIVE_PROVIDER_KEY,
        null,
      );
      if (!activeId) {
        this.logger.warn(
          'No active payment provider configured. system_configs.payment.activeProviderId is unset; order checkout will throw until it is seeded (run pending DB migrations).',
        );
        return;
      }
      const row = await this.repo.findOne({ where: { id: activeId } });
      if (!row) {
        this.logger.error(
          `system_configs.payment.activeProviderId points to ${activeId}, but no matching payment_providers row exists. Checkout will fail until this is reconciled.`,
        );
        return;
      }
      this.logger.log(
        `Active payment provider: ${row.slug} (${row.displayName}) — kind=${row.kind}, baseUrl=${row.baseUrl}`,
      );
    } catch (err) {
      this.logger.error(
        `PaymentGatewayRegistry boot probe failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Active provider — used by new checkouts, payouts, virtual-account
   * provisioning, and webhook signature verification (whichever
   * provider is currently active signs the webhooks we expect).
   */
  async getActive(): Promise<IPaymentGateway> {
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    if (!activeId) {
      throw new NotFoundException(
        'No active payment provider configured. Run pending DB migrations or set system_configs.payment.activeProviderId via the admin UI.',
      );
    }
    return this.get(activeId);
  }

  /**
   * Lookup-by-id — used by the admin Test button and any future flow
   * that needs to talk to a non-active provider (e.g. settling a
   * transaction that was initialized on the previous active provider
   * before a swap).
   */
  async get(providerId: string): Promise<IPaymentGateway> {
    const row = await this.repo.findOne({ where: { id: providerId } });
    if (!row) {
      throw new NotFoundException(`Payment provider ${providerId} not found.`);
    }
    if (!row.enabled) {
      throw new NotFoundException(
        `Payment provider ${row.slug} is disabled. Re-enable it in admin → payment settings to use it.`,
      );
    }
    const cacheKey = `${row.id}:${row.updatedAt.toISOString()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.insertedAt < CACHE_TTL_MS) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return hit.gateway;
    }
    if (hit) this.cache.delete(cacheKey);
    const gateway = this.build(row);
    this.cache.set(cacheKey, { gateway, insertedAt: Date.now() });
    this.enforceLruCap();
    return gateway;
  }

  invalidate(providerId: string): void {
    const prefix = `${providerId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  private build(row: PaymentProvider): IPaymentGateway {
    const secretKey = this.crypto.decryptSecret({
      cipher: row.secretCipher,
      nonce: row.secretNonce,
      tag: row.secretTag,
      keyVersion: row.keyVersion,
    });
    const webhookSecret =
      row.webhookSecretCipher && row.webhookSecretNonce && row.webhookSecretTag
        ? this.crypto.decryptSecret({
            cipher: row.webhookSecretCipher,
            nonce: row.webhookSecretNonce,
            tag: row.webhookSecretTag,
            keyVersion: row.keyVersion,
          })
        : null;

    switch (row.kind) {
      case PaymentProviderKind.PAYSTACK:
        return new PaystackGateway({
          providerId: row.id,
          providerSlug: row.slug,
          baseUrl: row.baseUrl,
          secretKey,
          webhookSecret,
          preferredBank: row.preferredBank,
        });
      default: {
        const exhaustive: never = row.kind;
        throw new Error(
          `Unsupported payment provider kind: ${String(exhaustive)}`,
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
