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
  ORDER = 'order',
  // STG-1 — audit row for credential / activation events on the
  // storage_providers table.
  STORAGE_PROVIDER = 'storage_provider',
  // STG-4 — audit row for cross-provider document migration jobs.
  STORAGE_MIGRATION = 'storage_migration',
  // PAY-1 — audit row for credential / activation events on the
  // payment_providers table.
  PAYMENT_PROVIDER = 'payment_provider',
}

export enum ApprovalAction {
  APPROVE = 'approve',
  REJECT = 'reject',
  SUSPEND = 'suspend',
  RESUME = 'resume',
  // STG-1 — recorded when the bootstrap migration seeds a
  // storage_providers row from the legacy SPACES_* env vars.
  BOOTSTRAP_SEED = 'bootstrap_seed',
  // STG-2 — admin-driven storage_providers events. The table doubles as
  // the platform's "admin state-change ledger" beyond just approvals;
  // the target_type discriminates which kind of action this is.
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  ACTIVATE = 'activate',
  // STG-4 — migration-job lifecycle. RESUME is reused from the existing
  // value set (originally for driver-suspension recovery).
  PAUSE = 'pause',
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

  // D1 — nullable so system-driven transitions (cron-flipped
  // suspensions, auto-pending on setup completion) can record a
  // decision row without a real reviewer. NULL is the documented
  // "system" sentinel.
  @Column({ type: 'uuid', nullable: true })
  reviewerId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'reviewerId' })
  reviewer: User | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'decidedAt' })
  decidedAt: Date;
}
