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
import type { Naira } from '../../common/money';
import { nairaTransformer } from '../../common/money';
import { PackageSize } from '../../orders/entities/order.entity';

/**
 * PG decimal → JS number for coordinates (see Order.numericDecimalTransformer
 * — same rationale: react-native-maps rejects string lat/lng).
 */
const numericDecimalTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null =>
    value == null ? null : parseFloat(value),
};

/**
 * Lifecycle of a request:
 *
 *  open       — broadcast to drivers; collecting offers
 *  resolved   — a winning offer was accepted; resolvedOrderId points
 *               at the persisted Order row
 *  expired    — TTL hit with no acceptance
 *  cancelled  — customer dismissed the request before resolution
 */
export enum OrderRequestStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/**
 * Pre-order dispatch object. Created the moment a customer taps
 * "Find driver" — drivers respond with offers (accept-at-quote OR
 * counter), customer picks a winner, and only THEN does an actual
 * Order row get created with the chosen driver + price.
 *
 * Replaces the legacy "create order, then hope a driver accepts"
 * model that produced orphan pending orders.
 */
@Entity('order_requests')
export class OrderRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  customerId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'customerId' })
  customer: User;

  @Index()
  @Column({
    type: 'enum',
    enum: OrderRequestStatus,
    enumName: 'order_request_status_enum',
    default: OrderRequestStatus.OPEN,
  })
  status: OrderRequestStatus;

  @Column('decimal', {
    precision: 10,
    scale: 7,
    transformer: numericDecimalTransformer,
  })
  pickupLatitude: number;

  @Column('decimal', {
    precision: 10,
    scale: 7,
    transformer: numericDecimalTransformer,
  })
  pickupLongitude: number;

  @Column()
  pickupAddress: string;

  @Column('decimal', {
    precision: 10,
    scale: 7,
    transformer: numericDecimalTransformer,
  })
  deliveryLatitude: number;

  @Column('decimal', {
    precision: 10,
    scale: 7,
    transformer: numericDecimalTransformer,
  })
  deliveryLongitude: number;

  @Column()
  deliveryAddress: string;

  @Column()
  recipientName: string;

  @Column()
  recipientPhone: string;

  @Column()
  packageDescription: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  packageWeight: number | null;

  @Column({
    type: 'enum',
    enum: PackageSize,
    default: PackageSize.MEDIUM,
  })
  packageSize: PackageSize;

  @Column({ type: 'text', nullable: true })
  deliveryNotes: string | null;

  // Suggested fare computed at request time — the "quote" both the
  // customer sees and the driver responds to. Counter offers differ
  // from this value; quote-accept matches it exactly.
  @Column('decimal', {
    precision: 10,
    scale: 2,
    transformer: nairaTransformer,
  })
  quotedPrice: Naira;

  // Snapshot of insurance fee at request time. Threaded onto the
  // resolved Order so retroactive config changes don't rewrite an
  // in-flight quote.
  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: nairaTransformer,
  })
  insuranceFee: Naira | null;

  // Per-order platform charge snapshot. Threaded onto the resolved
  // Order. Used for driver eligibility filtering — drivers whose
  // wallet balance is below (platformCharge + insuranceFee) don't
  // see the request.
  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: nairaTransformer,
  })
  platformCharge: Naira | null;

  // Haversine distance pickup → delivery, computed at request time.
  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  distanceKm: number | null;

  // 5-minute TTL. A cron sweeps expired requests + cancels their
  // open offers (releasing any wallet holds).
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  // Populated on resolve — points at the created Order row.
  @Column({ type: 'uuid', nullable: true })
  resolvedOrderId: string | null;

  // Populated on resolve — points at the winning DispatchOffer row.
  @Column({ type: 'uuid', nullable: true })
  resolvedOfferId: string | null;

  // Snapshot of eligible-driver pool size at request creation.
  // J4-style observability: was the pool too thin when nothing came
  // back?
  @Column({ type: 'integer', nullable: true })
  eligibleDriversAtBroadcast: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
