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

/**
 * PG `decimal` columns come back from node-postgres as strings to
 * preserve precision (JS `number` can't safely hold arbitrary
 * decimals). Coordinates fit comfortably inside Number's safe range
 * (±90 / ±180 with 7 fractional digits), so we coerce on read here
 * and the mobile `<Marker>` props receive real numbers instead of
 * strings — react-native-maps throws "value for latitude cannot be
 * set from string to double" otherwise.
 */
const numericDecimalTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null =>
    value == null ? null : parseFloat(value),
};

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
 * pending                : Paystack awaiting webhook confirmation (G1).
 * pending_cash           : Cash on delivery — driver still to collect (G2).
 * pending_transfer       : Manual bank transfer — customer hasn't yet
 *                          marked the transfer sent (G3).
 * customer_marked_paid   : Phase 3 — customer claims the transfer is
 *                          done; driver still to confirm receipt.
 * completed              : Money received and accounted for.
 * failed                 : Payment unrecoverable — admin reconcile path.
 */
export enum OrderPaymentStatus {
  PENDING = 'pending',
  PENDING_CASH = 'pending_cash',
  PENDING_TRANSFER = 'pending_transfer',
  CUSTOMER_MARKED_PAID = 'customer_marked_paid',
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

  // Delivery Location
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

  // Insurance fee captured at order-create time from
  // ORDER_INSURANCE_FEE_FIXED / ORDER_INSURANCE_FEE_PERCENT. Stored
  // here so retroactive config changes never rewrite historical
  // settlements. Debited from the rider's wallet at delivery
  // settlement; the customer never sees it on the price they pay.
  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: nairaTransformer,
  })
  insuranceFee: Naira | null;

  // Per-order platform charge captured at order-create time from the
  // DRIVER_CHARGE_* config (flat, or percentage-of-price capped). Stored
  // here so retroactive config changes never rewrite historical holds.
  // Held (DEBIT) from the driver's prepaid wallet when they ACCEPT the
  // order; refunded on cancellation; kept by the platform on delivery.
  // Also gates visibility — drivers below this amount don't see the order.
  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: nairaTransformer,
  })
  platformCharge: Naira | null;

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

  // Phase 3 — bank-transfer payment loop. Set when the customer
  // marks "I've paid" from the tracking screen. Distinct from
  // paymentConfirmedAt: this is the customer's claim; that's the
  // driver's confirmation.
  @Column({ type: 'timestamp', nullable: true })
  customerMarkedPaidAt: Date | null;

  // Set when the driver confirms receipt from the active-delivery
  // screen. Flips paymentStatus to COMPLETED.
  @Column({ type: 'timestamp', nullable: true })
  paymentConfirmedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Driver's current location (updated in real-time)
  @Column('decimal', {
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericDecimalTransformer,
  })
  driverLatitude: number;

  @Column('decimal', {
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericDecimalTransformer,
  })
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

  // Phase 2 dispatch — back-link to the OrderRequest that spawned
  // this order. Null on legacy orders (created directly via POST
  // /orders). Threaded through so admin tools can trace pricing
  // and offer history from the order back to the request.
  @Column({ type: 'uuid', nullable: true })
  orderRequestId: string | null;
}
