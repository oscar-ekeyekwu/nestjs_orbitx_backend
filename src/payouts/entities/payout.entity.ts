import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { nairaTransformer, type Naira } from '../../common/money';

export enum PayoutStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  PAID = 'paid',
  PENDING_MANUAL = 'pending_manual',
  FAILED = 'failed',
}

export enum PayoutMethod {
  AUTO = 'auto',
  MANUAL = 'manual',
}

/**
 * G4 — one row per (recipient, weekly period). Lifecycle in the
 * migration comment; the matching service in payouts.service.ts.
 */
@Entity('payouts')
export class Payout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  recipientUserId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'recipientUserId' })
  recipient: User;

  @Column({ type: 'uuid' })
  walletId: string;

  @ManyToOne(() => Wallet)
  @JoinColumn({ name: 'walletId' })
  wallet: Wallet;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    transformer: nairaTransformer,
  })
  amount: Naira;

  @Index()
  @Column({
    type: 'enum',
    enum: PayoutStatus,
    enumName: 'payout_status_enum',
    default: PayoutStatus.PENDING,
  })
  status: PayoutStatus;

  @Column({
    type: 'enum',
    enum: PayoutMethod,
    enumName: 'payout_method_enum',
    nullable: true,
  })
  method: PayoutMethod | null;

  @Column({ type: 'timestamptz' })
  periodStart: Date;

  @Column({ type: 'timestamptz' })
  periodEnd: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  paystackTransferCode: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  manualReceiptReference: string | null;

  @Column({ type: 'uuid', nullable: true })
  completedBy: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'completedBy' })
  completer: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
