import {
  Injectable,
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

@Injectable()
export class WalletService {
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
      balance: 0,
      totalEarnings: 0,
      totalWithdrawals: 0,
      pendingBalance: 0,
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
   * Get wallet balance
   */
  async getBalance(userId: string): Promise<number> {
    const wallet = await this.getWalletByUserId(userId);
    return Number(wallet.balance);
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

    return Number(wallet.balance) >= minBalance;
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

      const newBalance = Number(wallet.balance) + addFundsDto.amount;

      wallet.balance = newBalance;
      wallet.totalEarnings = Number(wallet.totalEarnings) + addFundsDto.amount;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        type: TransactionType.CREDIT,
        amount: addFundsDto.amount,
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

      if (Number(wallet.balance) < withdrawDto.amount) {
        throw new BadRequestException('Insufficient balance');
      }

      const newBalance = Number(wallet.balance) - withdrawDto.amount;

      wallet.balance = newBalance;
      wallet.totalWithdrawals =
        Number(wallet.totalWithdrawals) + withdrawDto.amount;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        type: TransactionType.DEBIT,
        amount: withdrawDto.amount,
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
    amount: number,
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

      // Calculate commission
      const commissionPercentage = await this.configService.getNumber(
        ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
        20,
      );
      const commission = (amount * commissionPercentage) / 100;
      const driverEarnings = amount - commission;

      const newBalance = Number(wallet.balance) + driverEarnings;

      wallet.balance = newBalance;
      wallet.totalEarnings = Number(wallet.totalEarnings) + driverEarnings;

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
          orderAmount: amount,
          commission,
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
   * Deduct security deposit when driver accepts an order
   */
  async deductSecurityDeposit(
    userId: string,
    orderId: string,
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

      const minBalance = await this.configService.getNumber(
        ConfigKey.DRIVER_MIN_BALANCE,
        0,
      );

      if (Number(wallet.balance) < minBalance) {
        throw new BadRequestException(
          `Insufficient balance. Minimum balance of ₦${minBalance} required`,
        );
      }

      const newBalance = Number(wallet.balance) - minBalance;
      wallet.balance = newBalance;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        orderId,
        type: TransactionType.DEBIT,
        amount: minBalance,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: PaymentMethod.WALLET,
        description: `Security deposit for order ${orderId}`,
        metadata: { type: 'security_deposit', orderId },
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
   * Refund security deposit when order is delivered or cancelled
   */
  async refundSecurityDeposit(
    userId: string,
    orderId: string,
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

      const minBalance = await this.configService.getNumber(
        ConfigKey.DRIVER_MIN_BALANCE,
        0,
      );

      const newBalance = Number(wallet.balance) + minBalance;
      wallet.balance = newBalance;

      await queryRunner.manager.save(wallet);

      const transaction = queryRunner.manager.create(Transaction, {
        walletId: wallet.id,
        orderId,
        type: TransactionType.CREDIT,
        amount: minBalance,
        balanceAfter: newBalance,
        status: TransactionStatus.COMPLETED,
        paymentMethod: PaymentMethod.WALLET,
        description: `Security deposit refund for order ${orderId}`,
        metadata: { type: 'security_deposit_refund', orderId },
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
    balance: number;
    totalEarnings: number;
    totalWithdrawals: number;
    pendingBalance: number;
    totalTransactions: number;
    canTakeOrders: boolean;
    minBalanceRequired: number;
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
      balance: Number(wallet.balance),
      totalEarnings: Number(wallet.totalEarnings),
      totalWithdrawals: Number(wallet.totalWithdrawals),
      pendingBalance: Number(wallet.pendingBalance),
      totalTransactions,
      canTakeOrders: Number(wallet.balance) >= minBalance,
      minBalanceRequired: minBalance,
    };
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
