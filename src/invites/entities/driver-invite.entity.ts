import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Generated,
} from 'typeorm';
import { Company } from '../../companies/entities/company.entity';
import { User } from '../../users/entities/user.entity';

/**
 * D4 — invite token a company_owner mints for a prospective driver.
 *
 * The token is the public link parameter. On the new driver's
 * registration, AuthService looks the row up by token, validates
 * expiry + unused, then links the new user to the inviting company.
 *
 * Tokens never get re-used; usedAt + redeemedByUserId flip exactly
 * once. Expired tokens are kept (audit) but rejected at redemption
 * time with errorCode INVITE_001.
 */
@Entity('driver_invites')
export class DriverInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company)
  @JoinColumn({ name: 'companyId' })
  company: Company;

  @Index()
  @Column()
  phone: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  @Generated('uuid')
  token: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  usedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  redeemedByUserId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'redeemedByUserId' })
  redeemedByUser: User | null;

  @Column({ type: 'uuid' })
  createdBy: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'createdBy' })
  creator: User;

  @CreateDateColumn()
  createdAt: Date;
}
