import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Vehicle } from './vehicle.entity';

/**
 * Active assignment of a vehicle to a driver. Soft-revoked via
 * `unassignedAt` (NULL = currently active).
 *
 * Uniqueness is enforced by a **partial unique index** on `vehicleId`
 * where `unassignedAt IS NULL` (declared in the migration), so a single
 * vehicle can have many historic assignments but only one open one. The
 * driver side is intentionally not unique — B5 lets one driver be active
 * on multiple vehicles across companies.
 */
@Entity('vehicle_assignments')
export class VehicleAssignment {
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
  vehicleId: string;

  @ManyToOne(() => Vehicle)
  @JoinColumn({ name: 'vehicleId' })
  vehicle: Vehicle;

  @Column({ type: 'timestamp', default: () => 'now()' })
  assignedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  unassignedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
