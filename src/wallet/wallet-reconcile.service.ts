import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from './entities/transaction.entity';
import { Naira, NAIRA_ZERO, naira } from '../common/money';

export interface WalletMismatch {
  walletId: string;
  userId: string;
  cachedBalance: string;
  ledgerBalance: string;
  driftNaira: string;
}

export interface ReconcileReport {
  walletsChecked: number;
  mismatches: WalletMismatch[];
}

/**
 * G6 — wallet-balance reconcile.
 *
 * Pre-migration, this swept every wallet and compared the cached
 * `wallets.balance` column against the COMPLETED ledger sum. The
 * column was dropped (see WalletBalanceView migration); the
 * `wallet_balances` view is now the single source of truth, so by
 * construction the cached and ledger values are identical.
 *
 * The class is kept (and the cron call site still ticks through) so
 * any historical wiring stays intact, but `reconcileAll` is a thin
 * sanity-sweep that walks every wallet and logs counts. Negative-
 * balance detection is the natural next addition.
 */
@Injectable()
export class WalletReconcileService {
  private readonly logger = new Logger(WalletReconcileService.name);

  constructor(
    @InjectRepository(Wallet)
    private readonly walletsRepo: Repository<Wallet>,
    @InjectRepository(Transaction)
    private readonly transactionsRepo: Repository<Transaction>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Sum a single wallet's COMPLETED ledger. Useful for ad-hoc
   * introspection; the live read path uses
   * `WalletService.getLedgerBalance` (same query, exposes the active
   * transaction manager for locking).
   */
  async ledgerBalance(walletId: string): Promise<Naira> {
    const rows = await this.transactionsRepo
      .createQueryBuilder('txn')
      .select('txn.type', 'type')
      .addSelect('COALESCE(SUM(txn.amount), 0)', 'total')
      .where('txn.walletId = :walletId', { walletId })
      .andWhere('txn.status = :status', {
        status: TransactionStatus.COMPLETED,
      })
      .groupBy('txn.type')
      .getRawMany<{ type: TransactionType; total: string }>();

    let credit: Naira = NAIRA_ZERO;
    let debit: Naira = NAIRA_ZERO;
    for (const row of rows) {
      if (row.type === TransactionType.CREDIT) credit = naira(row.total);
      else if (row.type === TransactionType.DEBIT) debit = naira(row.total);
    }
    return credit.minus(debit) as Naira;
  }

  /**
   * Sanity-sweep. With the cached column gone, balance drift is
   * structurally impossible — the report's `mismatches` is always
   * empty. Retained so the existing cron job (or any external
   * caller) keeps compiling; emits an INFO log per run.
   */
  async reconcileAll(): Promise<ReconcileReport> {
    const wallets = await this.walletsRepo.find();
    this.logger.log(
      `Wallet reconcile sweep — ${wallets.length} wallets (ledger is canonical; drift detection retired).`,
    );
    // Emit the same event shape with empty mismatches so any
    // listener (digest mailer etc.) keeps receiving heartbeats.
    this.events.emit('wallet.balance_mismatch', {
      walletsChecked: wallets.length,
      mismatches: [],
    });
    return { walletsChecked: wallets.length, mismatches: [] };
  }
}
