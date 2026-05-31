import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { SystemConfigService } from '../config/config.service';
import { StorageCryptoService } from '../storage/crypto.service';
import { CreatePaymentProviderDto } from './dto/create-payment-provider.dto';
import { UpdatePaymentProviderDto } from './dto/update-payment-provider.dto';
import { PaymentProvider } from './entities/payment-provider.entity';
import { PaymentGatewayRegistry } from './payment-gateway.registry';
import type { TestConnectionResult } from './interfaces/payment-gateway.interface';

const ACTIVE_PROVIDER_KEY = 'payment.activeProviderId';

export interface PaymentProviderView {
  id: string;
  slug: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  publicKey: string | null;
  preferredBank: string | null;
  secretKeyMasked: string;
  hasDedicatedWebhookSecret: boolean;
  enabled: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PaymentProvidersService {
  constructor(
    @InjectRepository(PaymentProvider)
    private readonly repo: Repository<PaymentProvider>,
    private readonly crypto: StorageCryptoService,
    private readonly config: SystemConfigService,
    private readonly approvals: ApprovalsService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly dataSource: DataSource,
  ) {}

  async list(): Promise<PaymentProviderView[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    return rows.map((row) => this.toView(row, activeId));
  }

  async findOne(id: string): Promise<PaymentProviderView> {
    const row = await this.requireRow(id);
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    return this.toView(row, activeId);
  }

  async create(
    dto: CreatePaymentProviderDto,
    actorUserId: string,
  ): Promise<PaymentProviderView> {
    const existing = await this.repo.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException(
        `A payment provider with slug "${dto.slug}" already exists.`,
      );
    }
    const secret = this.crypto.encryptSecret(dto.secretKey);
    const webhook = dto.webhookSecret
      ? this.crypto.encryptSecret(dto.webhookSecret)
      : null;
    const row = this.repo.create({
      slug: dto.slug,
      kind: dto.kind,
      displayName: dto.displayName,
      baseUrl: dto.baseUrl,
      publicKey: dto.publicKey ?? null,
      preferredBank: dto.preferredBank ?? null,
      secretCipher: secret.cipher,
      secretNonce: secret.nonce,
      secretTag: secret.tag,
      keyVersion: secret.keyVersion,
      webhookSecretCipher: webhook?.cipher ?? null,
      webhookSecretNonce: webhook?.nonce ?? null,
      webhookSecretTag: webhook?.tag ?? null,
      enabled: dto.enabled ?? true,
    });
    const saved = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.save(PaymentProvider, row);
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.PAYMENT_PROVIDER,
        targetId: persisted.id,
        action: ApprovalAction.CREATE,
        reviewerId: actorUserId,
        reason: `Created provider ${persisted.slug} (kind=${persisted.kind}).`,
      });
      return persisted;
    });
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    return this.toView(saved, activeId);
  }

  async update(
    id: string,
    dto: UpdatePaymentProviderDto,
    actorUserId: string,
  ): Promise<PaymentProviderView> {
    const row = await this.requireRow(id);

    if (dto.displayName !== undefined) row.displayName = dto.displayName;
    if (dto.baseUrl !== undefined) row.baseUrl = dto.baseUrl;
    if (dto.publicKey !== undefined) row.publicKey = dto.publicKey;
    if (dto.preferredBank !== undefined) {
      // Treat empty string as a clear so the form can null it out
      // with a single text input.
      row.preferredBank = dto.preferredBank === '' ? null : dto.preferredBank;
    }
    if (dto.enabled !== undefined) row.enabled = dto.enabled;

    if (dto.secretKey) {
      const secret = this.crypto.encryptSecret(dto.secretKey);
      row.secretCipher = secret.cipher;
      row.secretNonce = secret.nonce;
      row.secretTag = secret.tag;
      row.keyVersion = secret.keyVersion;
    }

    if (dto.webhookSecret !== undefined) {
      if (dto.webhookSecret === '') {
        // Explicit clear — fall back to the main secret for HMAC.
        row.webhookSecretCipher = null;
        row.webhookSecretNonce = null;
        row.webhookSecretTag = null;
      } else {
        const webhook = this.crypto.encryptSecret(dto.webhookSecret);
        row.webhookSecretCipher = webhook.cipher;
        row.webhookSecretNonce = webhook.nonce;
        row.webhookSecretTag = webhook.tag;
      }
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.save(PaymentProvider, row);
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.PAYMENT_PROVIDER,
        targetId: persisted.id,
        action: ApprovalAction.UPDATE,
        reviewerId: actorUserId,
        reason: `Updated provider ${persisted.slug}.`,
      });
      return persisted;
    });
    this.registry.invalidate(saved.id);
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    return this.toView(saved, activeId);
  }

  async remove(id: string, actorUserId: string): Promise<void> {
    const row = await this.requireRow(id);
    const activeId = await this.config.get<string | null>(
      ACTIVE_PROVIDER_KEY,
      null,
    );
    if (activeId === row.id) {
      throw new BadRequestException(
        `Cannot delete the active payment provider. Activate a different provider first.`,
      );
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(PaymentProvider, { id: row.id });
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.PAYMENT_PROVIDER,
        targetId: row.id,
        action: ApprovalAction.DELETE,
        reviewerId: actorUserId,
        reason: `Deleted provider ${row.slug}.`,
      });
    });
    this.registry.invalidate(row.id);
  }

  async activate(
    id: string,
    actorUserId: string,
  ): Promise<PaymentProviderView> {
    const row = await this.requireRow(id);
    if (!row.enabled) {
      throw new BadRequestException(
        `Cannot activate a disabled provider. Enable "${row.slug}" first.`,
      );
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO "system_configs" ("key", "value", "description", "dataType")
         VALUES ($1, $2, $3, 'string')
         ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
        [
          ACTIVE_PROVIDER_KEY,
          row.id,
          'PAY-1 — id of the payment_providers row PaymentService routes through.',
        ],
      );
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.PAYMENT_PROVIDER,
        targetId: row.id,
        action: ApprovalAction.ACTIVATE,
        reviewerId: actorUserId,
        reason: `Activated provider ${row.slug}.`,
      });
    });
    this.registry.invalidateAll();
    return this.toView(row, row.id);
  }

  /**
   * PAY-1 — admin Test button. Builds a gateway from the row's
   * credentials and hits its testConnection probe. Never decrypts and
   * returns the secret; the gateway's own probe runs inside the
   * registry's build flow.
   */
  async test(id: string): Promise<TestConnectionResult> {
    const row = await this.requireRow(id);
    if (!row.enabled) {
      return {
        ok: false,
        error: `Provider ${row.slug} is disabled. Enable it before testing.`,
      };
    }
    const gateway = await this.registry.get(row.id);
    return gateway.testConnection();
  }

  private async requireRow(id: string): Promise<PaymentProvider> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Payment provider ${id} not found.`);
    }
    return row;
  }

  private toView(
    row: PaymentProvider,
    activeId: string | null,
  ): PaymentProviderView {
    // Decrypt once just for the masked tail — the response NEVER carries
    // the full key. If decrypt fails (KEK drift / corrupted row) we
    // mask the slug instead so the admin can still see + delete the
    // broken row.
    let masked = '••••••????';
    try {
      const plaintext = this.crypto.decryptSecret({
        cipher: row.secretCipher,
        nonce: row.secretNonce,
        tag: row.secretTag,
        keyVersion: row.keyVersion,
      });
      masked = this.crypto.maskTrailing(plaintext);
    } catch {
      // leave default masked value
    }
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      displayName: row.displayName,
      baseUrl: row.baseUrl,
      publicKey: row.publicKey,
      preferredBank: row.preferredBank,
      secretKeyMasked: masked,
      hasDedicatedWebhookSecret: !!row.webhookSecretCipher,
      enabled: row.enabled,
      isActive: activeId === row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
