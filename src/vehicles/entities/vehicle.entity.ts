import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum VehicleOwnerType {
  INDIVIDUAL_DRIVER = 'individual_driver',
  COMPANY = 'company',
}

export enum VehicleType {
  MOTORCYCLE = 'motorcycle',
  CAR = 'car',
  VAN = 'van',
  TRUCK = 'truck',
  BICYCLE = 'bicycle',
}

export enum VehicleStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  ACTIVE = 'active',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
  RETIRED = 'retired',
}

/**
 * Vehicles use polymorphic ownership via (ownerType, ownerId) rather than
 * two nullable FKs (one to companies, one to driver_profiles). Cleaner
 * shape; matches the same pattern used on documents and approval_decisions.
 * Owner-side joins go through the polymorphic-owner helper (ARCH-4).
 */
@Entity('vehicles')
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VehicleOwnerType,
  })
  ownerType: VehicleOwnerType;

  @Index()
  @Column({ type: 'uuid' })
  ownerId: string;

  @Column({
    type: 'enum',
    enum: VehicleType,
  })
  type: VehicleType;

  @Index({ unique: true })
  @Column()
  plate: string;

  @Column({ type: 'varchar', nullable: true })
  color: string | null;

  @Column({ type: 'varchar', nullable: true })
  photoUrl: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: VehicleStatus,
    default: VehicleStatus.DRAFT,
  })
  status: VehicleStatus;

  @Column({ type: 'timestamp', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
