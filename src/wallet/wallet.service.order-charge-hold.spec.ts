import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { TransactionType } from './entities/transaction.entity';
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
  existingRefund?: unknown;
}) {
  const saved: Array<Record<string, unknown>> = [];
  const manager = {
    findOne: jest.fn().mockResolvedValue(opts.wallet),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
    save: jest.fn((entity: Record<string, unknown>) => {
      saved.push(entity);
      return Promise.resolve(entity);
    }),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(opts.existingRefund ?? null),
    })),
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
  it('debits the exact charge and records an order_charge_hold DEBIT', async () => {
    const { service, saved } = buildService({ wallet: wallet('5000') });

    const txn = await service.holdOrderCharge('u1', 'o1', naira('200'));

    expect(txn).not.toBeNull();
    const walletRow = saved.find((r) => r.balance !== undefined);
    expect((walletRow?.balance as Naira).toString()).toBe('4800');
    const txnRow = saved.find((r) => r.type === TransactionType.DEBIT);
    expect(txnRow).toBeDefined();
    expect((txnRow?.amount as Naira).toString()).toBe('200');
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
  it('credits the charge back and records an order_charge_refund CREDIT', async () => {
    const { service, saved } = buildService({ wallet: wallet('4800') });

    const txn = await service.refundOrderCharge('u1', 'o1', naira('200'));

    expect(txn).not.toBeNull();
    const walletRow = saved.find((r) => r.balance !== undefined);
    expect((walletRow?.balance as Naira).toString()).toBe('5000');
    const txnRow = saved.find((r) => r.type === TransactionType.CREDIT);
    expect(txnRow?.metadata).toEqual({
      type: 'order_charge_refund',
      orderId: 'o1',
    });
  });

  it('is idempotent — skips when a refund already exists for the order', async () => {
    const { service, saved } = buildService({
      wallet: wallet('4800'),
      existingRefund: { id: 'prior-refund' },
    });

    const txn = await service.refundOrderCharge('u1', 'o1', naira('200'));

    expect(txn).toEqual({ id: 'prior-refund' });
    // No new wallet/transaction rows written.
    expect(saved).toHaveLength(0);
  });

  it('is a no-op when the amount is zero', async () => {
    const { service, queryRunner } = buildService({ wallet: wallet('4800') });

    const txn = await service.refundOrderCharge('u1', 'o1', NAIRA_ZERO);

    expect(txn).toBeNull();
    expect(queryRunner.connect).not.toHaveBeenCalled();
  });
});
