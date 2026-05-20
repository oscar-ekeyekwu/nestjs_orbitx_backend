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
import { PaymentMethod } from '../../wallet/enums/payment-method.enum';

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

/**
 * Order-level payment lifecycle.
 *
 * pending          : Paystack awaiting webhook confirmation (G1).
 * pending_cash     : Cash on delivery — driver still to collect (G2).
 * pending_transfer : Manual bank transfer — admin still to reconcile (G3).
 * completed        : Money received and accounted for.
 * failed           : Payment unrecoverable — admin reconcile path.
 */
export enum OrderPaymentStatus {
  PENDING = 'pending',
  PENDING_CASH = 'pending_cash',
  PENDING_TRANSFER = 'pending_transfer',
  COMPLETED = 'completed',
  FAILED = 'failed',
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

  // G2 — chosen payment channel (defaults to cash since v0 implicitly
  // assumed cash on delivery). Updated server-side from CreateOrderDto.
  @Column({
    type: 'enum',
    enum: PaymentMethod,
    default: PaymentMethod.CASH,
  })
  paymentMethod: PaymentMethod;

  @Column({
    type: 'enum',
    enum: OrderPaymentStatus,
    enumName: 'order_payment_status_enum',
    default: OrderPaymentStatus.PENDING_CASH,
  })
  paymentStatus: OrderPaymentStatus;

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

  // J4 — order-match observability. Stamped at broadcast + accept so the
  // weekly admin report can show median time-to-first-accept, eligible
  // pool sizes at broadcast, and the winning driver's distance — the
  // signals that tell us whether to graduate to a directed-offer match.
  @Column({ type: 'integer', nullable: true })
  eligibleDriversAtBroadcast: number | null;

  @Column({ type: 'integer', nullable: true })
  timeToFirstAcceptMs: number | null;

  @Column('decimal', { precision: 10, scale: 3, nullable: true })
  winningDriverDistanceKm: number | null;

  // I6 — sticky flag turned on by an SOS event. The customer-facing
  // tracking screen renders a non-alarming "team is monitoring" banner
  // while this is true; the admin closes the incident which clears it.
  @Column({ type: 'boolean', default: false })
  incidentFlagged: boolean;
}
