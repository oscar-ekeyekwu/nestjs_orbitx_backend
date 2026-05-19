import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import {
  PaymentMethod,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../wallet/entities/transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { Naira, NAIRA_ZERO, naira } from '../common/money';
import type { IPaymentGateway } from '../payment/interfaces/payment-gateway.interface';
import { Payout, PayoutMethod, PayoutStatus } from './entities/payout.entity';

export interface MarkManualCompleteInput {
  receiptReference: string;
}

/**
 * G4 — weekly payout lifecycle.
 *
 *   generateWeeklyPayouts() — cron entry point. Iterates eligible
 *     recipients (drivers + company owners with wallet balance ≥
 *     MIN_PAYOUT_THRESHOLD) and INSERTs a pending Payout row per
 *     recipient. The (recipient, periodStart) unique constraint makes
 *     a re-run idempotent.
 *
 *   dispatchPending() — fans the pending rows out to either the
 *     Paystack auto path (recipient has a paystackRecipientCode) or
 *     the manual queue (everything else). Auto-path debits the wallet
 *     under pessimistic_write.
 *
 *   markManualComplete(id, input, admin) — admin marks a manual payout
 *     paid + provides the bank receipt reference. Same pessimistic
 *     wallet debit + transactions row insert.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    @InjectRepository(Payout)
    private readonly payoutsRepo: Repository<Payout>,
    @InjectRepository(Wallet)
    private readonly walletsRepo: Repository<Wallet>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly configService: SystemConfigService,
    @Inject('PAYMENT_GATEWAY')
    private readonly gateway: IPaymentGateway,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Cron entry point — runs every Monday at 00:00 Africa/Lagos.
   * `now` is injectable so tests can drive a deterministic week
   * boundary; production passes nothing.
   */
  async generateWeeklyPayouts(now: Date = new Date()): Promise<Payout[]> {
    const threshold = await this.configService.getNumber(
      ConfigKey.MIN_PAYOUT_THRESHOLD,
      1000,
    );
    const { periodStart, periodEnd } = this.priorWeekWindow(now);

    // Eligible: driver wallets (we also catch company-owner drivers
    // since their wallet is on the same user row) holding ≥ threshold.
    // Customer wallets are excluded by joining through users.role.
    const wallets = await this.walletsRepo
      .createQueryBuilder('wallet')
      .innerJoinAndSelect('wallet.user', 'user')
      .where('user.role = :role', { role: UserRole.DRIVER })
      .andWhere('user.isActive = :active', { active: true })
      .andWhere('CAST(wallet.balance AS numeric) >= :threshold', { threshold })
      .getMany();

    const created: Payout[] = [];
    for (const wallet of wallets) {
      try {
        const row = await this.payoutsRepo.save(
          this.payoutsRepo.create({
            recipientUserId: wallet.userId,
            walletId: wallet.id,
            amount: wallet.balance,
            status: PayoutStatus.PENDING,
            periodStart,
            periodEnd,
          }),
        );
        created.push(row);
      } catch (err) {
        // Unique violation on (recipient, periodStart) — the cron
        // already ran for this week. Idempotent.
        this.logger.warn(
          `Skipped existing payout for ${wallet.userId}: ${err}`,
        );
      }
    }
    this.logger.log(
      `Generated ${created.length} pending payouts for ${periodStart.toISOString()}`,
    );
    return created;
  }

  /**
   * Process every pending row: route to auto (Paystack) when the user
   * has a recipient code, manual queue otherwise.
   */
  async dispatchPending(): Promise<{
    auto: number;
    manual: number;
    failed: number;
  }> {
    const pending = await this.payoutsRepo.find({
      where: { status: PayoutStatus.PENDING },
      relations: ['recipient'],
    });

    let auto = 0;
    let manual = 0;
    let failed = 0;
    for (const payout of pending) {
      const code = payout.recipient?.paystackRecipientCode;
      if (!code) {
        await this.payoutsRepo.update(payout.id, {
          status: PayoutStatus.PENDING_MANUAL,
          method: PayoutMethod.MANUAL,
        });
        manual += 1;
        continue;
      }

      try {
        await this.payoutsRepo.update(payout.id, {
          status: PayoutStatus.PROCESSING,
          method: PayoutMethod.AUTO,
        });
        const result = await this.gateway.createTransfer({
          amountNaira: Number(payout.amount.toString()),
          recipientCode: code,
          reference: payout.id,
          reason: `Orbit weekly payout for ${payout.periodStart.toISOString().slice(0, 10)}`,
        });
        if (result.status === 'failed') {
          await this.markFailed(payout.id, 'Paystack reported failed');
          failed += 1;
          continue;
        }
        await this.settleAuto(payout.id, result.transferCode);
        auto += 1;
      } catch (err) {
        await this.markFailed(payout.id, String(err));
        failed += 1;
      }
    }

    return { auto, manual, failed };
  }

  /**
   * Admin marks a manual payout paid with the bank receipt reference.
   * Idempotent: a replay on a PAID row returns the row untouched.
   */
  async markManualComplete(
    id: string,
    input: MarkManualCompleteInput,
    admin: User,
  ): Promise<Payout> {
    this.assertAdmin(admin);
    if (!input.receiptReference?.trim()) {
      throw new BadRequestException('receiptReference is required.');
    }

    return this.dataSource.transaction(async (manager) => {
      const payout = await manager.findOne(Payout, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payout) {
        throw new NotFoundException('Payout not found.');
      }
      if (payout.status === PayoutStatus.PAID) {
        return payout;
      }
      if (payout.status !== PayoutStatus.PENDING_MANUAL) {
        throw new BadRequestException(
          `Cannot mark a ${payout.status} payout paid manually.`,
        );
      }

      const wallet = await manager.findOne(Wallet, {
        where: { id: payout.walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Wallet not found.');
      }
      if (wallet.balance.lt(payout.amount)) {
        throw new BadRequestException(
          'Wallet balance is below the payout amount; refusing to overdraft.',
        );
      }

      wallet.balance = wallet.balance.minus(payout.amount) as Naira;
      wallet.totalWithdrawals = (wallet.totalWithdrawals ?? NAIRA_ZERO).plus(
        payout.amount,
      ) as Naira;
      await manager.save(wallet);

      await manager.insert(Transaction, {
        walletId: wallet.id,
        type: TransactionType.DEBIT,
        amount: payout.amount,
        commission: NAIRA_ZERO,
        balanceAfter: wallet.balance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: PaymentMethod.BANK_TRANSFER,
        reference: input.receiptReference,
        description: `Weekly payout (manual disbursement by admin ${admin.id})`,
      });

      payout.status = PayoutStatus.PAID;
      payout.method = PayoutMethod.MANUAL;
      payout.manualReceiptReference = input.receiptReference;
      payout.completedBy = admin.id;
      payout.completedAt = new Date();
      const saved = await manager.save(payout);

      this.events.emit('payout.succeeded', {
        payoutId: saved.id,
        recipientUserId: saved.recipientUserId,
        amount: saved.amount.toString(),
        method: 'manual',
      });
      return saved;
    });
  }

  /**
   * Admin queue listing — pending_manual rows oldest-first so the
   * disbursement screen is FIFO.
   */
  async listManualPending(opts: {
    limit?: number;
    offset?: number;
  }): Promise<{ items: Payout[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const [items, total] = await this.payoutsRepo.findAndCount({
      where: { status: PayoutStatus.PENDING_MANUAL },
      relations: ['recipient'],
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * G4 statement stub — AC explicitly defers the PDF. Returns a
   * placeholder string so the eventual mobile / admin caller can wire
   * the link before the renderer ships.
   */
  getStatementPlaceholder(payoutId: string): {
    payoutId: string;
    message: string;
  } {
    return {
      payoutId,
      message: 'Statement download coming soon.',
    };
  }

  private async settleAuto(
    payoutId: string,
    transferCode: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const payout = await manager.findOne(Payout, {
        where: { id: payoutId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payout) return;
      const wallet = await manager.findOne(Wallet, {
        where: { id: payout.walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Wallet not found for payout settlement.');
      }
      wallet.balance = wallet.balance.minus(payout.amount) as Naira;
      wallet.totalWithdrawals = (wallet.totalWithdrawals ?? NAIRA_ZERO).plus(
        payout.amount,
      ) as Naira;
      await manager.save(wallet);

      await manager.insert(Transaction, {
        walletId: wallet.id,
        type: TransactionType.DEBIT,
        amount: payout.amount,
        commission: NAIRA_ZERO,
        balanceAfter: wallet.balance,
        status: TransactionStatus.COMPLETED,
        // Paystack transfers are bank-transfer-by-another-name; this
        // keeps PaymentMethod stable without inventing a new enum value.
        paymentMethod: PaymentMethod.BANK_TRANSFER,
        reference: transferCode,
        description: `Weekly payout (Paystack transfer ${transferCode})`,
      });

      payout.status = PayoutStatus.PAID;
      payout.method = PayoutMethod.AUTO;
      payout.paystackTransferCode = transferCode;
      payout.completedAt = new Date();
      await manager.save(payout);
    });

    this.events.emit('payout.succeeded', {
      payoutId,
      method: 'auto',
    });
  }

  private async markFailed(id: string, reason: string): Promise<void> {
    await this.payoutsRepo.update(id, {
      status: PayoutStatus.FAILED,
      failureReason: reason,
    });
    this.events.emit('payout.failed', { payoutId: id, reason });
  }

  /**
   * Prior week window in Africa/Lagos (Mon 00:00 to Sun 23:59:59.999).
   * Implemented as a calendar shift on a Date so the math is honest
   * about timezone — we treat the run as if it's at Lagos midnight.
   */
  private priorWeekWindow(now: Date): { periodStart: Date; periodEnd: Date } {
    // Africa/Lagos is UTC+1 year-round (no DST). Round `now` down to
    // the most recent Monday at midnight Lagos, then walk back 7 days
    // for the period start; periodEnd is that Monday minus 1ms.
    const lagosOffsetMs = 60 * 60 * 1000;
    const lagosNow = new Date(now.getTime() + lagosOffsetMs);
    const dayOfWeek = lagosNow.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const thisMondayLagos = new Date(
      Date.UTC(
        lagosNow.getUTCFullYear(),
        lagosNow.getUTCMonth(),
        lagosNow.getUTCDate() - daysSinceMonday,
      ),
    );
    const periodEnd = new Date(thisMondayLagos.getTime() - lagosOffsetMs - 1);
    const periodStart = new Date(
      thisMondayLagos.getTime() - 7 * 24 * 60 * 60 * 1000 - lagosOffsetMs,
    );
    return { periodStart, periodEnd };
  }

  private assertAdmin(caller: User): void {
    if (caller.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin role required.');
    }
  }
}

// Silence unused-import lint while `naira` is reserved for downstream
// hooks (statement renderer, etc.) without yet being called inline.
void naira;
