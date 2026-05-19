import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Wallet } from './wallet.entity';
import { Order } from '../../orders/entities/order.entity';
import type { Naira } from '../../common/money';
import { nairaTransformer } from '../../common/money';
import { PaymentMethod } from '../enums/payment-method.enum';

// G4 — PaymentMethod was inlined here pre-G4; it's now shared with the
// Order entity via wallet/enums/payment-method.enum.ts. Re-export to
// keep `import { PaymentMethod } from '../entities/transaction.entity'`
// working for the dozen existing call sites.
export { PaymentMethod };

export enum TransactionType {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REVERSED = 'reversed',
}

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  walletId: string;

  @ManyToOne(() => Wallet, (wallet) => wallet.transactions)
  @JoinColumn({ name: 'walletId' })
  wallet: Wallet;

  @Column({ nullable: true })
  orderId: string;

  @ManyToOne(() => Order, { nullable: true })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  type: TransactionType;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    transformer: nairaTransformer,
  })
  amount: Naira;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: nairaTransformer,
  })
  commission: Naira;

  /**
   * G5 — commission percentage applied at the time this row settled.
   * Stored alongside the absolute `commission` Naira amount so a future
   * rate change cannot retroactively rewrite historical splits. Nullable
   * for pre-G5 rows that pre-date the rate-locking contract.
   */
  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  commissionPct: string | null;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    transformer: nairaTransformer,
  })
  balanceAfter: Naira;

  @Column({
    type: 'enum',
    enum: TransactionStatus,
    default: TransactionStatus.PENDING,
  })
  status: TransactionStatus;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
    default: PaymentMethod.CASH,
  })
  paymentMethod: PaymentMethod;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text', nullable: true })
  reference: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
