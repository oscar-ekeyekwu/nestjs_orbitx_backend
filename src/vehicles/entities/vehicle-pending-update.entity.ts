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
import { Vehicle, VehicleType } from './vehicle.entity';

export enum VehiclePendingUpdateStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * F2 — staged regulatory edit for an approved vehicle. One pending row
 * per vehicle (enforced by the partial unique index in the matching
 * migration); historical resolved rows accumulate as an audit trail
 * alongside the canonical approval_decisions ledger.
 */
@Entity('vehicle_pending_updates')
export class VehiclePendingUpdate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  vehicleId: string;

  @ManyToOne(() => Vehicle, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vehicleId' })
  vehicle: Vehicle;

  @Column({ type: 'varchar', length: 32, nullable: true })
  proposedType: VehicleType | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  proposedPlate: string | null;

  @Column({ type: 'uuid' })
  submittedBy: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'submittedBy' })
  submitter: User;

  @Index()
  @Column({
    type: 'enum',
    enum: VehiclePendingUpdateStatus,
    enumName: 'vehicle_pending_update_status_enum',
    default: VehiclePendingUpdateStatus.PENDING,
  })
  status: VehiclePendingUpdateStatus;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'reviewedBy' })
  reviewer: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  reviewReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
