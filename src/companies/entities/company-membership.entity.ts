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
  // Pending: SMS / email invite issued, driver hasn't accepted yet.
  PENDING = 'pending',
  // Approved: driver is an active member of the company. Doubles as the
  // gate VehicleAssignmentsService consults before letting an owner
  // assign vehicles to this driver.
  APPROVED = 'approved',
  // Removed: soft-revoked membership. Row stays for audit; the driver
  // can be re-invited later (which writes a new pending row).
  REMOVED = 'removed',
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
