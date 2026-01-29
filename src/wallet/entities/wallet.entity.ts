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

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  balance: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  totalEarnings: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  totalWithdrawals: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  pendingBalance: number;

  @Column({ default: false })
  isLocked: boolean;

  @OneToMany(() => Transaction, (transaction) => transaction.wallet)
  transactions: Transaction[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
