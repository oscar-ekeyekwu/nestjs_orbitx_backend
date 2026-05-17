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

  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: nairaTransformer,
  })
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
