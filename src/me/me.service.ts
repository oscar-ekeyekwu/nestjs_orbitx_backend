import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import { DataSource } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { Document } from '../documents/entities/document.entity';
import { User } from '../users/entities/user.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { Transaction } from '../wallet/entities/transaction.entity';

export interface UserDataExport {
  exportedAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    phone: string | null;
    role: string;
    createdAt: string;
    consentedAt: string | null;
    deletionScheduledAt: string | null;
  };
  orders: Array<{
    id: string;
    status: string;
    pickupAddress: string;
    deliveryAddress: string;
    estimatedPrice: number | string;
    finalPrice: number | string | null;
    createdAt: string;
    deliveredAt: Date | null;
  }>;
  documents: Array<{
    id: string;
    type: string;
    status: string;
    expiryDate: Date | null;
    createdAt: string;
  }>;
  transactions: Array<{
    id: string;
    type: string;
    amount: number | string;
    createdAt: string;
  }>;
}

/**
 * I1 — NDPA data-subject-rights service. Owns:
 *   - export(userId)      → DR-N1, NDPA §31. Returns a JSON snapshot
 *                            of the user's first-party data.
 *   - requestDelete()     → DR-N2 / NDPA §34. Schedules the row for
 *                            pseudonymisation after a 30-day grace.
 *   - cancelDeletion()    → DR-N3. Clears `deletionScheduledAt`.
 *   - consent()           → DR-N5. Stamps `consentedAt` when the
 *                            user ticks the policy box.
 *   - sweepScheduledDeletions() → cron path. Pseudonymises overdue
 *                            rows: email, name, phone scrambled;
 *                            order history retained anonymised.
 */
@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Document)
    private readonly documents: Repository<Document>,
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly approvals: ApprovalsService,
  ) {}

  async export(userId: string): Promise<UserDataExport> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    const wallet = await this.wallets.findOne({ where: { userId } });
    const [orders, documents, transactions] = await Promise.all([
      this.orders.find({ where: { customerId: userId }, take: 1000 }),
      this.documents.find({ where: { ownerId: userId }, take: 1000 }),
      wallet
        ? this.transactions.find({ where: { walletId: wallet.id }, take: 1000 })
        : Promise.resolve([]),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        phone: user.phone ?? null,
        role: user.role,
        createdAt: user.createdAt.toISOString(),
        consentedAt: user.consentedAt ? user.consentedAt.toISOString() : null,
        deletionScheduledAt: user.deletionScheduledAt
          ? user.deletionScheduledAt.toISOString()
          : null,
      },
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        pickupAddress: o.pickupAddress,
        deliveryAddress: o.deliveryAddress,
        estimatedPrice: o.estimatedPrice as unknown as number,
        finalPrice: (o.finalPrice as unknown as number | null) ?? null,
        createdAt: o.createdAt.toISOString(),
        deliveredAt: o.deliveredAt ?? null,
      })),
      documents: documents.map((d) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        expiryDate: d.expiryDate,
        createdAt: d.createdAt.toISOString(),
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type as unknown as string,
        amount: t.amount as unknown as number,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  async requestDelete(userId: string): Promise<User> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('User not found.');
      if (user.deletionScheduledAt) {
        // Idempotent — re-requesting doesn't reset the clock.
        return user;
      }
      user.deletionScheduledAt = new Date();
      await manager.save(user);
      // Audit the request for compliance traceability.
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.DRIVER,
        targetId: user.id,
        action: ApprovalAction.DELETE,
        reviewerId: user.id,
        reason: 'NDPA §34 user-initiated deletion request',
      });
      return user;
    });
  }

  async cancelDeletion(userId: string): Promise<User> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('User not found.');
      if (!user.deletionScheduledAt) {
        throw new BadRequestException(
          'You have no pending deletion request to cancel.',
        );
      }
      if (user.pseudonymizedAt) {
        throw new BadRequestException(
          'Deletion already executed; the account is anonymised and cannot be restored.',
        );
      }
      user.deletionScheduledAt = null;
      await manager.save(user);
      await this.approvals.recordDecision(manager, {
        targetType: ApprovalTargetType.DRIVER,
        targetId: user.id,
        action: ApprovalAction.RESUME,
        reviewerId: user.id,
        reason: 'NDPA §34 user-initiated deletion request cancelled',
      });
      return user;
    });
  }

  async consent(userId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    if (user.consentedAt) return user;
    user.consentedAt = new Date();
    return this.users.save(user);
  }

  /**
   * I1 — daily cron. Pseudonymises every user whose
   * `deletionScheduledAt` is older than the grace window (30 days)
   * and who hasn't already been pseudonymised. Order history stays
   * (with the user_id intact) because DR-N3 permits anonymised
   * retention for accounting.
   */
  async sweepScheduledDeletions(now: Date = new Date()): Promise<{
    sweptUserIds: string[];
  }> {
    const graceCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = await this.users
      .createQueryBuilder('u')
      .where('u."deletionScheduledAt" IS NOT NULL')
      .andWhere('u."pseudonymizedAt" IS NULL')
      .andWhere('u."deletionScheduledAt" <= :graceCutoff', { graceCutoff })
      .getMany();
    const sweptUserIds: string[] = [];
    for (const user of rows) {
      try {
        const tag = `deleted_user_${user.id.slice(0, 8)}`;
        user.email = `${tag}@deleted.invalid`;
        user.phone = '';
        user.first_name = 'Deleted';
        user.last_name = 'User';
        user.googleId = '';
        user.avatar = '';
        user.isActive = false;
        user.pseudonymizedAt = now;
        await this.users.save(user);
        sweptUserIds.push(user.id);
        this.logger.log(
          `NDPA pseudonymised user ${user.id} after 30-day grace.`,
        );
      } catch (err) {
        this.logger.error(
          `NDPA sweep failed for user ${user.id}: ${(err as Error).message}`,
        );
      }
    }
    return { sweptUserIds };
  }
}
