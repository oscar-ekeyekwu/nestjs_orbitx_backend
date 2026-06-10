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
import { OrderRequest } from './order-request.entity';

/**
 * A driver's response to an OrderRequest.
 *
 *   quote_accept — driver agrees to the customer's quoted price.
 *                  Triggers AUTO-WIN: the controller resolves the
 *                  request immediately (no customer step).
 *   counter      — driver proposes a different price + ETA. Queues
 *                  in the customer's offer list; customer picks one.
 */
export enum DispatchOfferType {
  QUOTE_ACCEPT = 'quote_accept',
  COUNTER = 'counter',
}

/**
 * Lifecycle of an offer:
 *
 *   pending    — submitted, awaiting customer decision (or auto-win
 *                if it's a quote_accept)
 *   accepted   — won the request; the resolved Order is now active
 *   rejected   — explicitly skipped by the customer
 *   expired    — the parent request expired OR this offer's 60s
 *                TTL elapsed without resolution
 *   withdrawn  — driver retracted the offer before resolution
 */
export enum DispatchOfferStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  WITHDRAWN = 'withdrawn',
}

@Entity('dispatch_offers')
export class DispatchOffer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  requestId: string;

  @ManyToOne(() => OrderRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  request: OrderRequest;

  // Index alone — uniqueness across pending offers is enforced by
  // the partial index in the migration so a driver can't have two
  // simultaneous open offers (single-active-offer rule).
  @Index()
  @Column({ type: 'uuid' })
  driverId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column({
    type: 'enum',
    enum: DispatchOfferType,
    enumName: 'dispatch_offer_type_enum',
  })
  type: DispatchOfferType;

  @Column({
    type: 'enum',
    enum: DispatchOfferStatus,
    enumName: 'dispatch_offer_status_enum',
    default: DispatchOfferStatus.PENDING,
  })
  status: DispatchOfferStatus;

  // For quote_accept this mirrors the request's quotedPrice (server
  // copies it at submit time so a price change can't sneak in via
  // race). For counter this is the driver's proposed price.
  @Column('decimal', {
    precision: 10,
    scale: 2,
    transformer: nairaTransformer,
  })
  price: Naira;

  // Driver's estimated time to reach pickup, in seconds. Surfaced
  // on the customer's offer card.
  @Column({ type: 'integer' })
  etaSeconds: number;

  // One-line free-form note attached to a counter offer
  // (e.g. "rain — bumping by 200"). Always null for quote_accept.
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  // 60-second TTL. The expiry cron releases offers past this
  // timestamp + flips them to EXPIRED so the customer's list
  // self-cleans.
  @Column({ type: 'timestamp' })
  offerExpiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
