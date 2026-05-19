/* eslint-disable @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unsafe-assignment --
 * The mocked TypeORM query builder is intentionally `any`-typed for
 * conciseness; the real getRawMany return shape is type-checked at the
 * service site. */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WalletReconcileService } from './wallet-reconcile.service';
import { Wallet } from './entities/wallet.entity';
import { Transaction, TransactionType } from './entities/transaction.entity';
import { naira, NAIRA_ZERO } from '../common/money';

function buildWallet(
  id: string,
  balance: string,
  userId = `user-${id}`,
): Wallet {
  return {
    id,
    userId,
    balance: naira(balance),
    totalEarnings: NAIRA_ZERO,
    totalWithdrawals: NAIRA_ZERO,
  } as Wallet;
}

function buildQB(
  ledgerByWalletId: Record<string, { credit?: string; debit?: string }>,
) {
  return jest.fn().mockImplementation(() => {
    const state: { walletId?: string } = {};
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn((_clause: string, params: { walletId?: string }) => {
        if (params?.walletId !== undefined) state.walletId = params.walletId;
        return qb;
      }),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(() => {
        const rows: { type: TransactionType; total: string }[] = [];
        const totals = state.walletId
          ? ledgerByWalletId[state.walletId]
          : undefined;
        if (totals?.credit !== undefined) {
          rows.push({ type: TransactionType.CREDIT, total: totals.credit });
        }
        if (totals?.debit !== undefined) {
          rows.push({ type: TransactionType.DEBIT, total: totals.debit });
        }
        return Promise.resolve(rows);
      }),
    };
    return qb;
  });
}

describe('WalletReconcileService (G6)', () => {
  let service: WalletReconcileService;
  let walletsRepo: { find: jest.Mock };
  let transactionsRepo: { createQueryBuilder: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    walletsRepo = { find: jest.fn() };
    transactionsRepo = { createQueryBuilder: jest.fn() };
    events = { emit: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        WalletReconcileService,
        { provide: getRepositoryToken(Wallet), useValue: walletsRepo },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepo,
        },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = mod.get(WalletReconcileService);
  });

  describe('ledgerBalance', () => {
    it('returns credit - debit across COMPLETED transactions', async () => {
      transactionsRepo.createQueryBuilder = buildQB({
        'wallet-1': { credit: '1000', debit: '250' },
      });

      const balance = await service.ledgerBalance('wallet-1');
      expect(balance.toString()).toBe('750');
    });

    it('returns 0 for a wallet with no transactions', async () => {
      transactionsRepo.createQueryBuilder = buildQB({});

      const balance = await service.ledgerBalance('wallet-empty');
      expect(balance.toString()).toBe('0');
    });

    it('handles credit-only wallets (no debits ever)', async () => {
      transactionsRepo.createQueryBuilder = buildQB({
        'wallet-1': { credit: '500' },
      });

      const balance = await service.ledgerBalance('wallet-1');
      expect(balance.toString()).toBe('500');
    });
  });

  describe('reconcileAll', () => {
    it('reports a clean run when every wallet matches its ledger', async () => {
      walletsRepo.find.mockResolvedValueOnce([
        buildWallet('wallet-1', '750'),
        buildWallet('wallet-2', '0'),
      ]);
      transactionsRepo.createQueryBuilder = buildQB({
        'wallet-1': { credit: '1000', debit: '250' },
        'wallet-2': {},
      });

      const report = await service.reconcileAll();

      expect(report.walletsChecked).toBe(2);
      expect(report.mismatches).toEqual([]);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('records a mismatch + emits wallet.balance_mismatch when cached drifts', async () => {
      // wallet.balance says 1000 but the ledger says 750 → drift of +250
      walletsRepo.find.mockResolvedValueOnce([buildWallet('wallet-1', '1000')]);
      transactionsRepo.createQueryBuilder = buildQB({
        'wallet-1': { credit: '1000', debit: '250' },
      });

      const report = await service.reconcileAll();

      expect(report.mismatches).toEqual([
        {
          walletId: 'wallet-1',
          userId: 'user-wallet-1',
          cachedBalance: '1000',
          ledgerBalance: '750',
          driftNaira: '250',
        },
      ]);
      expect(events.emit).toHaveBeenCalledWith(
        'wallet.balance_mismatch',
        expect.objectContaining({
          walletsChecked: 1,
          mismatches: expect.arrayContaining([
            expect.objectContaining({ walletId: 'wallet-1' }),
          ]),
        }),
      );
    });

    it('captures negative drift correctly (ledger ahead of cached)', async () => {
      walletsRepo.find.mockResolvedValueOnce([buildWallet('wallet-1', '500')]);
      transactionsRepo.createQueryBuilder = buildQB({
        'wallet-1': { credit: '1000', debit: '250' }, // ledger 750
      });

      const report = await service.reconcileAll();
      expect(report.mismatches[0].driftNaira).toBe('-250');
    });

    it('reports mixed clean + dirty wallets in one pass', async () => {
      walletsRepo.find.mockResolvedValueOnce([
        buildWallet('wallet-clean', '500'),
        buildWallet('wallet-dirty', '1000'),
      ]);
      transactionsRepo.createQueryBuilder = buildQB({
        'wallet-clean': { credit: '500' },
        'wallet-dirty': { credit: '500' },
      });

      const report = await service.reconcileAll();

      expect(report.walletsChecked).toBe(2);
      expect(report.mismatches.map((m) => m.walletId)).toEqual([
        'wallet-dirty',
      ]);
    });

    it('emits no alert when there are zero wallets in the system', async () => {
      walletsRepo.find.mockResolvedValueOnce([]);

      const report = await service.reconcileAll();

      expect(report.walletsChecked).toBe(0);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
