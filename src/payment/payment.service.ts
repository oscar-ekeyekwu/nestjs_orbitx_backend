import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import {
  PaymentMethod,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../wallet/entities/transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { NAIRA_ZERO, naira, type Naira } from '../common/money';
import type {
  InitializePaymentResult,
  VerifyPaymentResult,
  VirtualAccountResult,
  WebhookEvent,
} from './interfaces/payment-gateway.interface';
import { PaymentGatewayRegistry } from './payment-gateway.registry';

export interface InitializeOrderPaymentResult extends InitializePaymentResult {
  transactionId: string;
}

/**
 * G1 — verify response shape returned to the mobile client. Mirrors
 * the underlying Transaction status, since after settlement that's the
 * source of truth (Paystack might still report 'pending' for a few
 * seconds before their state catches up).
 */
export interface VerifyOrderPaymentResult {
  reference: string;
  status: 'completed' | 'failed' | 'pending';
  orderId: string | null;
}

/**
 * ARCH-13 — Paystack initialize + webhook orchestration.
 *
 * Owns the order-payment lifecycle: mint a pending Transaction, hand
 * its id to Paystack as the canonical reference, then on
 * `charge.success` mark the row complete and credit the customer's
 * wallet under a pessimistic_write lock. `charge.failed` flips the row
 * to FAILED. Both paths are idempotent — a webhook replay finds the
 * already-resolved row and short-circuits.
 *
 * The legacy wallet-funding (virtual account) flow stays on the
 * existing PaymentController + WalletService.addFunds path.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly registry: PaymentGatewayRegistry,
    @InjectRepository(Transaction)
    private readonly transactionsRepo: Repository<Transaction>,
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createVirtualAccount(params: {
    userId: string;
    name: string;
    email: string;
    bvn?: string;
  }): Promise<VirtualAccountResult> {
    const gateway = await this.registry.getActive();
    return gateway.createVirtualAccount(params);
  }

  async verifyWebhookSignature(
    payload: Buffer,
    signature: string,
  ): Promise<boolean> {
    const gateway = await this.registry.getActive();
    return gateway.verifyWebhookSignature(payload, signature);
  }

  async parseWebhookEvent(payload: unknown): Promise<WebhookEvent | null> {
    const gateway = await this.registry.getActive();
    return gateway.parseWebhookEvent(payload);
  }

  /**
   * Initialize a Paystack hosted-page charge for an order. Mints a
   * pending Transaction first so the webhook handler can find the row
   * by Paystack-echoed `reference` (= transaction.id).
   */
  async initializeOrderPayment(
    orderId: string,
    callerUserId: string,
    callerEmail: string,
  ): Promise<InitializeOrderPaymentResult> {
    const order = await this.ordersRepo.findOne({
      where: { id: orderId },
      relations: ['customer'],
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.customerId !== callerUserId) {
      throw new ForbiddenException(
        'Only the order customer can initialize a payment.',
      );
    }

    const wallet = await this.dataSource.getRepository(Wallet).findOne({
      where: { userId: callerUserId },
    });
    if (!wallet) {
      throw new BadRequestException('Customer wallet not provisioned.');
    }

    const amountSource = order.finalPrice ?? order.estimatedPrice;
    const amountNaira = amountSource ? Number(amountSource.toString()) : 0;
    if (amountNaira <= 0) {
      throw new BadRequestException(
        'Order amount must be greater than zero before charging.',
      );
    }

    // Mint the pending row first. Reference = transaction.id, which
    // Paystack echoes back verbatim on the webhook so the handler does
    // a single-row lookup without scanning metadata.
    // balanceAfter on a PENDING row is informational — settlement
    // recomputes the post-balance against the live ledger.
    const txn = await this.transactionsRepo.save(
      this.transactionsRepo.create({
        walletId: wallet.id,
        orderId,
        type: TransactionType.CREDIT,
        amount: naira(amountNaira.toString()),
        commission: NAIRA_ZERO,
        balanceAfter: NAIRA_ZERO,
        status: TransactionStatus.PENDING,
        paymentMethod: PaymentMethod.CARD,
        description: `Paystack charge for order ${orderId}`,
      }),
    );

    const gateway = await this.registry.getActive();
    const result = await gateway.initializePayment({
      transactionId: txn.id,
      orderId,
      email: callerEmail,
      amountNaira,
    });

    return {
      transactionId: txn.id,
      accessCode: result.accessCode,
      reference: result.reference,
      authorizationUrl: result.authorizationUrl,
    };
  }

  /**
   * Webhook entry point for `charge.success`. Idempotent — a replay
   * lands on an already-completed row and exits without re-crediting.
   * Wallet credit runs inside the same transaction under a
   * pessimistic_write lock on the wallet row.
   */
  async settleSuccessfulCharge(reference: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const txn = await manager.findOne(Transaction, {
        where: { id: reference },
      });
      if (!txn) {
        this.logger.warn(`Webhook for unknown transaction ${reference}`);
        return;
      }
      if (txn.status === TransactionStatus.COMPLETED) {
        // Duplicate webhook — already settled.
        return;
      }
      if (txn.status === TransactionStatus.FAILED) {
        // Race: charge eventually succeeded after a failed-event
        // already landed. Flip back to completed, but log loudly.
        this.logger.warn(
          `Charge ${reference} succeeded after a previous failure event`,
        );
      }

      const wallet = await manager.findOne(Wallet, {
        where: { id: txn.walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException(`Wallet ${txn.walletId} not found`);
      }

      // Compute balanceAfter against the live ledger; nothing to
      // mutate on the wallet itself — the view derives balance from
      // completed transactions, and we're about to flip this one to
      // COMPLETED.
      const currentBalance = await this.ledgerBalance(wallet.id, manager);
      txn.status = TransactionStatus.COMPLETED;
      txn.balanceAfter = currentBalance.plus(txn.amount) as Naira;
      await manager.save(txn);
    });

    // Best-effort downstream notification — fires AFTER the txn commits.
    this.eventEmitter.emit('payment.succeeded', { reference });
  }

  /**
   * G1 — manual verify path called by the mobile client when it
   * returns from the Paystack hosted page. Defends against missed /
   * delayed webhooks: if the local Transaction is still pending, ask
   * Paystack and reconcile through the same idempotent code paths the
   * webhook uses.
   *
   * Caller must be the customer who owns the transaction, mirrored
   * via order.customerId. Admins are allowed through for ops support.
   */
  async verifyOrderPayment(
    reference: string,
    caller: { id: string; role: 'customer' | 'driver' | 'admin' },
  ): Promise<VerifyOrderPaymentResult> {
    const txn = await this.transactionsRepo.findOne({
      where: { id: reference },
      relations: ['order'],
    });
    if (!txn) {
      throw new NotFoundException('Transaction not found');
    }
    if (caller.role !== 'admin' && txn.order?.customerId !== caller.id) {
      throw new ForbiddenException(
        'Only the order customer can verify this payment.',
      );
    }

    // Already terminal — trust the local row over a fresh Paystack lookup.
    if (txn.status === TransactionStatus.COMPLETED) {
      return {
        reference: txn.id,
        status: 'completed',
        orderId: txn.orderId ?? null,
      };
    }
    if (txn.status === TransactionStatus.FAILED) {
      return {
        reference: txn.id,
        status: 'failed',
        orderId: txn.orderId ?? null,
      };
    }

    // Still pending — query Paystack and reconcile.
    let remote: VerifyPaymentResult;
    try {
      const gateway = await this.registry.getActive();
      remote = await gateway.verifyPayment(reference);
    } catch (err) {
      this.logger.warn(
        `Paystack verify failed for ${reference}; staying pending: ${err}`,
      );
      return {
        reference,
        status: 'pending',
        orderId: txn.orderId ?? null,
      };
    }

    if (remote.status === 'success') {
      await this.settleSuccessfulCharge(reference);
      return {
        reference,
        status: 'completed',
        orderId: txn.orderId ?? null,
      };
    }
    if (remote.status === 'failed') {
      await this.markChargeFailed(reference);
      return {
        reference,
        status: 'failed',
        orderId: txn.orderId ?? null,
      };
    }
    // Paystack still pending — return as-is; another verify call later
    // (or the webhook) will close the loop.
    return {
      reference,
      status: 'pending',
      orderId: txn.orderId ?? null,
    };
  }

  /**
   * Webhook entry point for `charge.failed`. Idempotent.
   */
  async markChargeFailed(reference: string): Promise<void> {
    const txn = await this.transactionsRepo.findOne({
      where: { id: reference },
    });
    if (!txn) {
      this.logger.warn(
        `Failed-charge webhook for unknown transaction ${reference}`,
      );
      return;
    }
    if (txn.status === TransactionStatus.FAILED) {
      return;
    }
    if (txn.status === TransactionStatus.COMPLETED) {
      this.logger.warn(
        `Refusing to mark already-completed charge ${reference} as failed`,
      );
      return;
    }
    txn.status = TransactionStatus.FAILED;
    await this.transactionsRepo.save(txn);
    this.eventEmitter.emit('payment.failed', { reference });
  }

  /**
   * Compute a wallet's COMPLETED ledger sum inside the caller's
   * transaction manager. Matches the canonical `wallet_balances`
   * view but is safe to read while holding a row lock on the
   * wallet.
   */
  private async ledgerBalance(
    walletId: string,
    manager: import('typeorm').EntityManager,
  ): Promise<Naira> {
    const row = await manager
      .createQueryBuilder()
      .select(
        `COALESCE(SUM(CASE
           WHEN t."type" = 'credit' AND t."status" = 'completed' THEN t."amount"
           WHEN t."type" = 'debit'  AND t."status" = 'completed' THEN -t."amount"
           ELSE 0 END), 0)`,
        'balance',
      )
      .from('transactions', 't')
      .where('t."walletId" = :walletId', { walletId })
      .getRawOne<{ balance: string }>();
    return naira(String(row?.balance ?? 0)) as Naira;
  }
}
