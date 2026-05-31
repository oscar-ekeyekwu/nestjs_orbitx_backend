import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
  PaymentMethod,
} from './entities/transaction.entity';
import { VirtualAccount } from './entities/virtual-account.entity';
import { AddFundsDto } from './dto/add-funds.dto';
import { WithdrawFundsDto } from './dto/withdraw-funds.dto';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { PaymentService } from '../payment/payment.service';
import { Naira, NAIRA_ZERO, naira, nairaToJSON } from '../common/money';

/**
 * G5 — return shape from `WalletService.applyCommission`. Captures the
 * rate that was used so the caller can lock it onto the row.
 */
export interface CommissionSplit {
  driverShare: Naira;
  commission: Naira;
  /** Rate used at split time, expressed as a number (e.g. 15 for 15%). */
  commissionPct: number;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectRepository(Wallet)
    private walletRepository: Repository<Wallet>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(VirtualAccount)
    private virtualAccountRepository: Repository<VirtualAccount>,
    private dataSource: DataSource,
    private configService: SystemConfigService,
    private paymentService: PaymentService,
  ) {}

  /**
   * G5 — single point of truth for splitting a gross delivery fee
   * into commission + driver share. Reads the live rate from
   * system_config when not explicitly passed. All arithmetic stays on
   * Naira / decimal.js per ARCH-1 — never floats.
   *
   * Edge cases:
   *   - 0%      → commission ₦0, full fee to driver.
   *   - 100%    → entire fee is commission, driver gets ₦0.
   *   - fractional (e.g. 17.5%) honored at decimal precision.
   *   - negative or >100 rates throw (config tampering guard).
   */
  async applyCommission(
    grossFee: Naira,
    overridePct?: number,
  ): Promise<CommissionSplit> {
    const pct =
      overridePct ??
      (await this.configService.getNumber(
        ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
        15,
      ));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(
        `Invalid commission percentage: ${pct}. Must be in [0, 100].`,
      );
    }
    const commission = grossFee.times(pct).dividedBy(100) as Naira;
    const driverShare = grossFee.minus(commission) as Naira;
    return { driverShare, commission, commissionPct: pct };
  }

  /**
   * Compute the per-order platform charge held from the driver's prepaid
   * wallet on acceptance. Single source of truth for the charge so the
   * order-create snapshot, the visibility gate and the hold all agree.
   *
   * Mode switch (DRIVER_CHARGE_MODE):
   *   - 'percentage' → DRIVER_CHARGE_PERCENTAGE of the order price, capped
   *     by DRIVER_CHARGE_CAP when that cap is > 0.
   *   - 'flat' (or any unknown value) → DRIVER_CHARGE_FLAT.
   *
   * Runs on the order-create hot path, so config tampering is CLAMPED and
   * logged rather than thrown — a misconfigured rate must never 500 a
   * customer's create-order call.
   *
   * Edge cases:
   *   - charge 0 is allowed (free order; the balance gate passes trivially).
   *   - the charge MAY exceed the order price — it is wallet-funded platform
   *     revenue, independent of the cash the customer hands the driver, so
   *     it is intentionally not clamped to the price.
   *   - never negative.
   */
  async computeOrderCharge(orderPrice: Naira): Promise<Naira> {
    const mode = (
      await this.configService.getString(ConfigKey.DRIVER_CHARGE_MODE, 'flat')
    )
      .trim()
      .toLowerCase();

    if (mode === 'percentage') {
      let pct = await this.configService.getNumber(
        ConfigKey.DRIVER_CHARGE_PERCENTAGE,
        0,
      );
      if (!Number.isFinite(pct) || pct < 0) {
        this.logger.warn(
          `DRIVER_CHARGE_PERCENTAGE is ${pct}; clamping to 0. Review config.`,
        );
        pct = 0;
      } else if (pct > 100) {
        this.logger.warn(
          `DRIVER_CHARGE_PERCENTAGE is ${pct}; clamping to 100. Review config.`,
        );
        pct = 100;
      }
      // Whole-Naira charge (HALF_UP via decimal.js default rounding).
      let charge = naira(orderPrice.times(pct).dividedBy(100).toFixed(0));

      const cap = await this.configService.getNumber(
        ConfigKey.DRIVER_CHARGE_CAP,
        0,
      );
      if (Number.isFinite(cap) && cap > 0) {
        const capNaira = naira(String(cap));
        if (charge.greaterThan(capNaira)) {
          charge = capNaira;
        }
      }
      return charge;
    }

    // Flat mode (default). Unknown mode values fall through to flat so a
    // typo in config can't make orders free or crash the create path.
    const flat = await this.configService.getNumber(
      ConfigKey.DRIVER_CHARGE_FLAT,
      0,
    );
    if (!Number.isFinite(flat) || flat < 0) {
      this.logger.warn(
        `DRIVER_CHARGE_FLAT is ${flat}; treating as 0. Review config.`,
      );
      return NAIRA_ZERO;
    }
    return naira(String(flat));
  }

  /**
   * Create a wallet for a user
   */
  async createWallet(userId: string): Promise<Wallet> {
    const existing = await this.walletRepository.findOne({
      where: { userId },
    });

    if (existing) {
      return existing;
    }

    const wallet = this.walletRepository.create({
      userId,
      balance: NAIRA_ZERO,
      totalEarnings: NAIRA_ZERO,
      totalWithdrawals: NAIRA_ZERO,
      pendingBalance: NAIRA_ZERO,
    });

    return this.walletRepository.save(wallet);
  }

  /**
   * Get wallet by user ID
   */
  async getWalletByUserId(userId: string): Promise<Wallet> {
    let wallet = await this.walletRepository.findOne({
      where: { userId },
      relations: ['user'],
    });

    if (!wallet) {
      wallet = await this.createWallet(userId);
    }

    return wallet;
  }

  /**
   * Get wallet balance as the canonical Naira wire string `"x.xx"`.
   */
  async getBalance(userId: string): Promise<string> {
    const wallet = await this.getWalletByUserId(userId);
    return wallet.balance.toFixed(2);
  }

  /**
   * Check if driver meets minimum balance requirement
   */
  async canDriverTakeOrder(userId: string): Promise<boolean> {
    const wallet = await this.getWalletByUserId(userId);
    const minBalance = await this.configService.getNumber(
      ConfigKey.DRIVER_MIN_BALANCE,
      0,
    );

    return wallet.balance.greaterThanOrEqualTo(minBalance);
  }

  /**
   * Per-order balance gate: can this driver cover the given order charge?
   * Replaces the static min-balance check on the accept path so a driver
   * is gated against the specific order's charge, not a flat threshold.
   */
  async canDriverCoverCharge(userId: string, charge: Naira): Promise<boolean> {
    const wallet = await this.getWalletByUserId(userId);
    return wallet.balance.greaterThanOrEqualTo(charge);
  }

  /**
   * Add funds to wallet
   */
  async addFunds(
    userId: string,
    addFundsDto: AddFundsDto,
  ): Promise<Transaction> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      if (wallet.isLocked) {
        throw new ForbiddenException('Wallet is locked');
      }

      const amount = naira(String(addFundsDto.amount));
      const newBalance = wallet.balance.plus(amount) as Naira;

      wallet.balance = newBalance;
      wallet.totalEarnings = wallet.totalEarnings.plus(amount) as Naira;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        type: TransactionType.CREDIT,
        amount,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: addFundsDto.paymentMethod,
        description: addFundsDto.description || 'Wallet top-up',
        reference: addFundsDto.reference,
      });

      const savedTransaction = await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Withdraw funds from wallet
   */
  async withdrawFunds(
    userId: string,
    withdrawDto: WithdrawFundsDto,
  ): Promise<Transaction> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      if (wallet.isLocked) {
        throw new ForbiddenException('Wallet is locked');
      }

      const amount = naira(String(withdrawDto.amount));

      if (wallet.balance.lessThan(amount)) {
        throw new BadRequestException('Insufficient balance');
      }

      const newBalance = wallet.balance.minus(amount) as Naira;

      wallet.balance = newBalance;
      wallet.totalWithdrawals = wallet.totalWithdrawals.plus(amount) as Naira;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        type: TransactionType.DEBIT,
        amount,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: PaymentMethod.BANK_TRANSFER,
        description: withdrawDto.description || 'Wallet withdrawal',
        reference: withdrawDto.reference,
      });

      const savedTransaction = await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Process order payment (for drivers)
   */
  async processOrderPayment(
    userId: string,
    orderId: string,
    amount: Naira | string | number,
    paymentMethod: PaymentMethod = PaymentMethod.CASH,
  ): Promise<Transaction> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      if (wallet.isLocked) {
        throw new ForbiddenException('Wallet is locked');
      }

      const orderAmount = naira(String(amount));

      // Calculate commission
      const commissionPercentage = await this.configService.getNumber(
        ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
        20,
      );
      const commission = orderAmount
        .times(commissionPercentage)
        .dividedBy(100) as Naira;
      const driverEarnings = orderAmount.minus(commission) as Naira;

      const newBalance = wallet.balance.plus(driverEarnings) as Naira;

      wallet.balance = newBalance;
      wallet.totalEarnings = wallet.totalEarnings.plus(driverEarnings) as Naira;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        orderId,
        type: TransactionType.CREDIT,
        amount: driverEarnings,
        commission,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod,
        description: `Payment for order ${orderId}`,
        metadata: {
          orderAmount: orderAmount.toFixed(2),
          commission: commission.toFixed(2),
          commissionPercentage,
        },
      });

      const savedTransaction = await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get transaction history
   */
  async getTransactions(
    userId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const wallet = await this.getWalletByUserId(userId);

    const [transactions, total] = await this.transactionRepository.findAndCount(
      {
        where: { walletId: wallet.id },
        order: { createdAt: 'DESC' },
        take: limit,
        skip: offset,
        relations: ['order'],
      },
    );

    return { transactions, total };
  }

  /**
   * Get transaction by ID
   */
  async getTransactionById(
    transactionId: string,
    userId: string,
  ): Promise<Transaction> {
    const wallet = await this.getWalletByUserId(userId);

    const transaction = await this.transactionRepository.findOne({
      where: { id: transactionId, walletId: wallet.id },
      relations: ['order'],
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    return transaction;
  }

  /**
   * Lock wallet (admin action)
   */
  async lockWallet(userId: string): Promise<Wallet> {
    const wallet = await this.getWalletByUserId(userId);
    wallet.isLocked = true;
    return this.walletRepository.save(wallet);
  }

  /**
   * Unlock wallet (admin action)
   */
  async unlockWallet(userId: string): Promise<Wallet> {
    const wallet = await this.getWalletByUserId(userId);
    wallet.isLocked = false;
    return this.walletRepository.save(wallet);
  }

  /**
   * Hold the per-order platform charge from the driver's prepaid wallet
   * when they accept an order. Debits the exact `amount` (the order's
   * snapshotted platformCharge) — NOT the static min balance.
   *
   *   - amount <= 0 → no-op (no wallet write, no ₦0 transaction row).
   *   - insufficient balance → BadRequestException (own pessimistic_write
   *     re-check is the concurrency backstop for the accept path's
   *     pre-lock gate).
   *
   * Returns the inserted DEBIT transaction, or null when amount <= 0.
   */
  async holdOrderCharge(
    userId: string,
    orderId: string,
    amount: Naira,
  ): Promise<Transaction | null> {
    if (amount.lessThanOrEqualTo(NAIRA_ZERO)) {
      return null;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      if (wallet.isLocked) {
        throw new ForbiddenException('Wallet is locked');
      }

      if (wallet.balance.lessThan(amount)) {
        throw new BadRequestException(
          `Insufficient wallet balance. ₦${amount.toString()} required to cover this order's charge.`,
        );
      }

      const newBalance = wallet.balance.minus(amount) as Naira;
      wallet.balance = newBalance;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        orderId,
        type: TransactionType.DEBIT,
        amount,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: PaymentMethod.WALLET,
        description: `Order charge hold for order ${orderId}`,
        metadata: { type: 'order_charge_hold', orderId },
      });

      const savedTransaction = await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Refund a held order charge when an accepted order is cancelled.
   * Credits the exact `amount` back to the driver's wallet.
   *
   *   - amount <= 0 → no-op.
   *   - idempotent: skips if an `order_charge_refund` CREDIT row already
   *     exists for this order (guards a retried/replayed cancel).
   *
   * Returns the inserted CREDIT transaction, or null when nothing was done.
   */
  async refundOrderCharge(
    userId: string,
    orderId: string,
    amount: Naira,
  ): Promise<Transaction | null> {
    if (amount.lessThanOrEqualTo(NAIRA_ZERO)) {
      return null;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      // Idempotency guard: don't double-refund the same order.
      const existingRefund = await queryRunner.manager
        .createQueryBuilder(Transaction, 'txn')
        .where('txn.walletId = :walletId', { walletId: wallet.id })
        .andWhere('txn.orderId = :orderId', { orderId })
        .andWhere("txn.metadata->>'type' = :type", {
          type: 'order_charge_refund',
        })
        .getOne();
      if (existingRefund) {
        await queryRunner.commitTransaction();
        return existingRefund;
      }

      const newBalance = wallet.balance.plus(amount) as Naira;
      wallet.balance = newBalance;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        orderId,
        type: TransactionType.CREDIT,
        amount,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: PaymentMethod.WALLET,
        description: `Order charge refund for order ${orderId}`,
        metadata: { type: 'order_charge_refund', orderId },
      });

      const savedTransaction = await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get wallet statistics
   */
  async getWalletStats(userId: string): Promise<{
    balance: string;
    totalEarnings: string;
    totalWithdrawals: string;
    pendingBalance: string;
    totalTransactions: number;
    canTakeOrders: boolean;
    minBalanceRequired: string;
  }> {
    const wallet = await this.getWalletByUserId(userId);
    const minBalance = await this.configService.getNumber(
      ConfigKey.DRIVER_MIN_BALANCE,
      0,
    );
    const totalTransactions = await this.transactionRepository.count({
      where: { walletId: wallet.id },
    });

    return {
      balance: nairaToJSON(wallet.balance) ?? '0.00',
      totalEarnings: nairaToJSON(wallet.totalEarnings) ?? '0.00',
      totalWithdrawals: nairaToJSON(wallet.totalWithdrawals) ?? '0.00',
      pendingBalance: nairaToJSON(wallet.pendingBalance) ?? '0.00',
      totalTransactions,
      canTakeOrders: wallet.balance.greaterThanOrEqualTo(minBalance),
      minBalanceRequired: naira(String(minBalance)).toFixed(2),
    };
  }

  /**
   * Resolve the user id that owns a given virtual-account number.
   * Used by the Paystack webhook handler to attribute a DVA funding
   * event to a wallet when the charge metadata doesn't carry a
   * userId. Returns null when no matching row exists (stray webhook,
   * test event, deleted account).
   */
  async findUserIdByVirtualAccountNumber(
    accountNumber: string,
  ): Promise<string | null> {
    const row = await this.virtualAccountRepository.findOne({
      where: { accountNumber },
    });
    return row?.userId ?? null;
  }

  /**
   * Get or create a virtual account for a driver (idempotent)
   */
  async getOrCreateVirtualAccount(
    userId: string,
    name: string,
    email: string,
  ): Promise<VirtualAccount> {
    const existing = await this.virtualAccountRepository.findOne({
      where: { userId },
    });

    if (existing) {
      return existing;
    }

    const result = await this.paymentService.createVirtualAccount({
      userId,
      name,
      email,
    });

    const virtualAccount = this.virtualAccountRepository.create({
      userId,
      accountNumber: result.accountNumber,
      bankName: result.bankName,
      accountName: result.accountName,
      providerReference: result.providerReference,
      provider: result.provider,
    });

    return this.virtualAccountRepository.save(virtualAccount);
  }
}
