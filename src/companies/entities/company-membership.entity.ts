import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Company } from './company.entity';

export enum CompanyMembershipRole {
  OWNER = 'owner',
  EMPLOYEE = 'employee',
}

export enum CompanyMembershipStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Maps drivers to the companies they operate under. v1 ships with exactly
 * one owner per company, but the seam is left here so multi-owner
 * organizations don't need a schema change later.
 */
@Entity('company_memberships')
export class CompanyMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  driverId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Index()
  @Column({ type: 'uuid' })
  companyId: string;

  @ManyToOne(() => Company)
  @JoinColumn({ name: 'companyId' })
  company: Company;

  @Column({
    type: 'enum',
    enum: CompanyMembershipRole,
    default: CompanyMembershipRole.EMPLOYEE,
  })
  role: CompanyMembershipRole;

  @Index()
  @Column({
    type: 'enum',
    enum: CompanyMembershipStatus,
    default: CompanyMembershipStatus.PENDING,
  })
  status: CompanyMembershipStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
