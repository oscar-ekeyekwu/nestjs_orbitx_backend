import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { Naira } from '../../common/money';
import { nairaTransformer } from '../../common/money';

export enum OrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  PICKED_UP = 'picked_up',
  IN_TRANSIT = 'in_transit',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

export enum PackageSize {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  customerId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'customerId' })
  customer: User;

  @Column({ nullable: true })
  driverId: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  // Pickup Location
  @Column('decimal', { precision: 10, scale: 7 })
  pickupLatitude: number;

  @Column('decimal', { precision: 10, scale: 7 })
  pickupLongitude: number;

  @Column()
  pickupAddress: string;

  // Delivery Location
  @Column('decimal', { precision: 10, scale: 7 })
  deliveryLatitude: number;

  @Column('decimal', { precision: 10, scale: 7 })
  deliveryLongitude: number;

  @Column()
  deliveryAddress: string;

  // Recipient Details
  @Column()
  recipientName: string;

  @Column()
  recipientPhone: string;

  // Package Details
  @Column()
  packageDescription: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  packageWeight: number;

  @Column({
    type: 'enum',
    enum: PackageSize,
    default: PackageSize.MEDIUM,
  })
  packageSize: PackageSize;

  @Column({ type: 'text', nullable: true })
  deliveryNotes: string;

  // Pricing — branded Naira (decimal.js) via nairaTransformer (ARCH-1).
  // Wire format is "\d+\.\d{2}" string; arithmetic must go through
  // .plus/.minus/.times/.dividedBy (number arithmetic is a compile error).
  @Column('decimal', {
    precision: 10,
    scale: 2,
    transformer: nairaTransformer,
  })
  estimatedPrice: Naira;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: nairaTransformer,
  })
  finalPrice: Naira | null;

  // Timestamps
  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  pickedUpAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Driver's current location (updated in real-time)
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  driverLatitude: number;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  driverLongitude: number;
}
