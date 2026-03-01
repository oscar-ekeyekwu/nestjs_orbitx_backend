import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('virtual_accounts')
export class VirtualAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  userId: string;

  @Column()
  accountNumber: string;

  @Column()
  bankName: string;

  @Column()
  accountName: string;

  @Column()
  providerReference: string;

  @Column({ default: 'paystack' })
  provider: string;

  @CreateDateColumn()
  createdAt: Date;
}
