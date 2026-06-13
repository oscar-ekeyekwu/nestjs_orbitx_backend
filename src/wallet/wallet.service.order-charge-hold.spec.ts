import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import {
  TransactionStatus,
  TransactionType,
} from './entities/transaction.entity';
import { naira, NAIRA_ZERO, type Naira } from '../common/money';

/**
 * Minimal in-memory wallet row the mock query-runner hands back. Balance
 * is a branded Naira so the service's decimal arithmetic runs for real.
 */
interface MockWallet {
  id: string;
  userId: string;
  balance: Naira;
  isLocked: boolean;
}

/**
 * Build a WalletService backed by a fake DataSource whose query-runner
 * exposes just the manager surface the hold/refund methods touch:
 * findOne (wallet), createQueryBuilder (refund idempotency probe),
 * create + save (transaction row).
 */
function buildService(opts: {
  wallet: MockWallet | null;
  existingHold?: Record<string, unknown> | null;
  /** Optional override for the simulated ledger balance returned by
   *  the ledger-sum query. Defaults to `wallet.balance` so existing
   *  tests pass unchanged. */
  ledgerBalance?: string;
}) {
  const saved: Array<Record<string, unknown>> = [];
  // Two distinct createQueryBuilder shapes: the entity-aware one (for
  // findOne hold lookups) and the raw-select one (for the ledger
  // SUM). The mock returns whichever the caller is about to drive.
  const makeBuilder = () => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: jest.fn(() => builder),
      addSelect: jest.fn(() => builder),
      from: jest.fn(() => builder),
      where: jest.fn(() => builder),
      andWhere: jest.fn(() => builder),
      groupBy: jest.fn(() => builder),
      setParameters: jest.fn(() => builder),
      getRawOne: jest
        .fn()
        .mockResolvedValue({
          balance: opts.ledgerBalance ?? opts.wallet?.balance?.toString() ?? '0',
        }),
      getRawMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(opts.existingHold ?? null),
    });
    return builder;
  };
  const manager = {
    findOne: jest.fn().mockResolvedValue(opts.wallet),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
    save: jest.fn((entity: Record<string, unknown>) => {
      saved.push(entity);
      return Promise.resolve(entity);
    }),
    createQueryBuilder: jest.fn(() => makeBuilder()),
  };
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
    manager,
  };
  const service = new WalletService(
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    {} as never,
    {} as never,
  );
  return { service, manager, queryRunner, saved };
}

function wallet(balance: string, isLocked = false): MockWallet {
  return { id: 'w1', userId: 'u1', balance: naira(balance), isLocked };
}

describe('WalletService.holdOrderCharge', () => {
  it('records a PENDING DEBIT without changing wallet balance', async () => {
    const { service, saved } = buildService({ wallet: wallet('5000') });

    const txn = await service.holdOrderCharge('u1', 'o1', naira('200'));

    expect(txn).not.toBeNull();
    // Balance is intentionally untouched; the DEBIT is PENDING and
    // doesn't count against the displayed (completed-only) balance.
    const walletRow = saved.find((r) => r.balance !== undefined);
    expect(walletRow).toBeUndefined();
    const txnRow = saved.find((r) => r.type === TransactionType.DEBIT);
    expect(txnRow).toBeDefined();
    expect((txnRow?.amount as Naira).toString()).toBe('200');
    expect(txnRow?.status).toBe(TransactionStatus.PENDING);
    expect(txnRow?.metadata).toEqual({
      type: 'order_charge_hold',
      orderId: 'o1',
    });
  });

  it('is a no-op when the charge is zero', async () => {
    const { service, queryRunner } = buildService({ wallet: wallet('5000') });

    const txn = await service.holdOrderCharge('u1', 'o1', NAIRA_ZERO);

    expect(txn).toBeNull();
    expect(queryRunner.connect).not.toHaveBeenCalled();
  });

  it('throws when the balance cannot cover the charge', async () => {
    const { service } = buildService({ wallet: wallet('100') });

    await expect(
      service.holdOrderCharge('u1', 'o1', naira('200')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when the wallet is locked', async () => {
    const { service } = buildService({ wallet: wallet('5000', true) });

    await expect(
      service.holdOrderCharge('u1', 'o1', naira('200')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('WalletService.refundOrderCharge', () => {
  it('flips the matching PENDING hold to REVERSED', async () => {
    const existingHold = {
      id: 'txn-1',
      status: TransactionStatus.PENDING,
      amount: naira('200'),
      metadata: { type: 'order_charge_hold', orderId: 'o1' },
    };
    const { service, saved } = buildService({
      wallet: wallet('5000'),
      existingHold,
    });

    const txn = await service.refundOrderCharge('u1', 'o1', naira('200'));

    expect(txn).not.toBeNull();
    // The same row was mutated, no new transaction inserted.
    expect((txn as unknown as Record<string, unknown>).status).toBe(
      TransactionStatus.REVERSED,
    );
    // Balance never moved (the hold was PENDING).
    const walletRow = saved.find(
      (r) => r.balance !== undefined && !('status' in r),
    );
    expect(walletRow).toBeUndefined();
  });

  it('is a no-op when no matching hold exists (already cleared)', async () => {
    const { service } = buildService({
      wallet: wallet('5000'),
      existingHold: null,
    });

    const txn = await service.refundOrderCharge('u1', 'o1', naira('200'));

    expect(txn).toBeNull();
  });

  it('is idempotent — returns the already-reversed row without re-saving', async () => {
    const alreadyReversed = {
      id: 'txn-1',
      status: TransactionStatus.REVERSED,
      amount: naira('200'),
      metadata: { type: 'order_charge_hold', orderId: 'o1' },
    };
    const { service, saved } = buildService({
      wallet: wallet('5000'),
      existingHold: alreadyReversed,
    });

    const txn = await service.refundOrderCharge('u1', 'o1', naira('200'));

    expect(txn).toEqual(alreadyReversed);
    expect(saved).toHaveLength(0);
  });

  it('is a no-op when the amount is zero', async () => {
    const { service, queryRunner } = buildService({ wallet: wallet('5000') });

    const txn = await service.refundOrderCharge('u1', 'o1', NAIRA_ZERO);

    expect(txn).toBeNull();
    expect(queryRunner.connect).not.toHaveBeenCalled();
  });
});
