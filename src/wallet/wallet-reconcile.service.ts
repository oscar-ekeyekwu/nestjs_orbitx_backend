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
 * Computes `sum(credits) - sum(debits)` from the transactions table for
 * every wallet and compares it to the cached `wallet.balance` column.
 * Mismatches log a structured warning + emit `wallet.balance_mismatch`
 * for downstream alerting (email digest, push to oncall, etc.).
 *
 * Only COMPLETED transactions are summed — pending / failed rows
 * represent in-flight or aborted money movements that haven't settled
 * against the wallet yet.
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
   * Sums COMPLETED credits and debits for a single wallet and returns
   * the ledger-derived balance.
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
   * Walks every wallet and reports mismatches between
   * wallet.balance and the ledger-derived total. Doesn't mutate any
   * row — operator decides whether to auto-correct or investigate.
   */
  async reconcileAll(): Promise<ReconcileReport> {
    const wallets = await this.walletsRepo.find();
    const mismatches: WalletMismatch[] = [];
    for (const wallet of wallets) {
      const ledger = await this.ledgerBalance(wallet.id);
      if (!wallet.balance.eq(ledger)) {
        const drift = wallet.balance.minus(ledger) as Naira;
        mismatches.push({
          walletId: wallet.id,
          userId: wallet.userId,
          cachedBalance: wallet.balance.toString(),
          ledgerBalance: ledger.toString(),
          driftNaira: drift.toString(),
        });
        this.logger.warn(
          `Wallet balance drift wallet=${wallet.id} user=${wallet.userId} ` +
            `cached=${wallet.balance.toString()} ledger=${ledger.toString()} ` +
            `drift=${drift.toString()}`,
        );
      }
    }
    if (mismatches.length > 0) {
      this.events.emit('wallet.balance_mismatch', {
        walletsChecked: wallets.length,
        mismatches,
      });
    } else {
      this.logger.log(
        `Wallet reconcile clean — ${wallets.length} wallets balanced.`,
      );
    }
    return { walletsChecked: wallets.length, mismatches };
  }
}
