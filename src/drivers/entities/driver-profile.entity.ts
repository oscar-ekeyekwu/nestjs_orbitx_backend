import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Company } from '../../companies/entities/company.entity';
import type { Naira } from '../../common/money';
import { nairaTransformer } from '../../common/money';

export enum DriverAccountType {
  INDIVIDUAL = 'individual',
  COMPANY_OWNER = 'company_owner',
  COMPANY_EMPLOYEE = 'company_employee',
}

/**
 * Verification lifecycle (ARCH-3 state machine):
 *   setup_required → pending_approval → approved → active
 *                                                 ↘ rejected
 *                                                 ↘ suspended_docs_expired
 *                                                 ↘ suspended_admin
 *
 * Drivers cannot go online until `verification_status = active`.
 */
export enum DriverVerificationStatus {
  SETUP_REQUIRED = 'setup_required',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  ACTIVE = 'active',
  REJECTED = 'rejected',
  SUSPENDED_DOCS_EXPIRED = 'suspended_docs_expired',
  SUSPENDED_ADMIN = 'suspended_admin',
}

@Entity('driver_profiles')
export class DriverProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // v1 multi-tenant fields (ARCH-2)
  @Index()
  @Column({
    type: 'enum',
    enum: DriverAccountType,
    default: DriverAccountType.INDIVIDUAL,
  })
  accountType: DriverAccountType;

  @Index()
  @Column({
    type: 'enum',
    enum: DriverVerificationStatus,
    default: DriverVerificationStatus.SETUP_REQUIRED,
  })
  verificationStatus: DriverVerificationStatus;

  // Tunde-as-individual: accountType='individual' AND companyId IS NULL.
  // No phantom company row is created for solo drivers.
  @Index()
  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true })
  @JoinColumn({ name: 'companyId' })
  company: Company | null;

  @Column({ default: false })
  isOnline: boolean;

  @Column({ default: false })
  isOnDelivery: boolean;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  currentLatitude: number;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  currentLongitude: number;

  @Column({ nullable: true })
  vehicleType: string;

  @Column({ nullable: true })
  vehiclePlate: string;

  @Column({ nullable: true })
  licenseNumber: string;

  @Column({ default: 0 })
  totalDeliveries: number;

  @Column('decimal', { precision: 3, scale: 2, default: 0 })
  rating: number;

  @Column({ default: 0 })
  totalRatings: number;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: nairaTransformer,
  })
  totalEarnings: Naira;

  @Column({ default: true })
  isVerified: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
