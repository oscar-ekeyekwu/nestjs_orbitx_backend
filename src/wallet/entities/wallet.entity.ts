import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Transaction } from './transaction.entity';
import type { Naira } from '../../common/money';
import { nairaTransformer } from '../../common/money';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Hydrated at read time from the `wallet_balances` view (or a SUM
   * over completed transactions when a row lock is held). NOT a
   * persisted column — writes don't update it; the ledger does.
   * See `WalletService.getBalance` / `getWalletByUserId`.
   */
  balance: Naira;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: nairaTransformer,
  })
  totalEarnings: Naira;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: nairaTransformer,
  })
  totalWithdrawals: Naira;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: nairaTransformer,
  })
  pendingBalance: Naira;

  @Column({ default: false })
  isLocked: boolean;

  @OneToMany(() => Transaction, (transaction) => transaction.wallet)
  transactions: Transaction[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
