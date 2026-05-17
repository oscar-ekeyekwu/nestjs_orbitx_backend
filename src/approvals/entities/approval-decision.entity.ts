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

export enum ApprovalTargetType {
  DRIVER = 'driver',
  COMPANY = 'company',
  VEHICLE = 'vehicle',
  DOCUMENT = 'document',
}

export enum ApprovalAction {
  APPROVE = 'approve',
  REJECT = 'reject',
  SUSPEND = 'suspend',
  RESUME = 'resume',
}

/**
 * Append-only audit ledger of every approval / rejection / suspension
 * issued by admins. Row writes are scoped to the same DB transaction
 * that mutates the target entity's status, so the audit and state
 * always agree.
 *
 * Immutability is enforced at the Postgres role level: the
 * `InitialV1Migration` REVOKEs UPDATE and DELETE from `orbit_app` on
 * this table (see NFR-S5). No `@UpdateDateColumn`.
 */
@Entity('approval_decisions')
export class ApprovalDecision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({
    type: 'enum',
    enum: ApprovalTargetType,
  })
  targetType: ApprovalTargetType;

  @Index()
  @Column({ type: 'uuid' })
  targetId: string;

  @Column({
    type: 'enum',
    enum: ApprovalAction,
  })
  action: ApprovalAction;

  @Column({ type: 'uuid' })
  reviewerId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'reviewerId' })
  reviewer: User;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'decidedAt' })
  decidedAt: Date;
}
