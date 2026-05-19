import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';

/**
 * E3 — opaque token a customer can mint for an in-progress order so a
 * recipient (or anyone with the link) can read the stripped public
 * timeline without authenticating.
 */
@Entity('order_share_tokens')
export class OrderShareToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  token: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  orderId: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  /**
   * Hard upper bound — nullable for in-progress orders. The public
   * endpoint additionally enforces the "completed + 24h" cutoff
   * against the order's deliveredAt at read time so we don't have to
   * mutate this column when the order finishes.
   */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
