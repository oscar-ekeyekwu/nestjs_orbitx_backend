import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum IncidentStatus {
  OPEN = 'open',
  ACKNOWLEDGED = 'acknowledged',
  CLOSED = 'closed',
}

export enum IncidentOutcome {
  RESOLVED = 'resolved',
  ESCALATED_FRSC = 'escalated_frsc',
  REFERRED_INSURANCE = 'referred_insurance',
  FALSE_ALARM = 'false_alarm',
}

/**
 * I6 — single SOS event raised by a driver during an active delivery.
 *
 * Lifecycle:
 *   open         → driver pressed SOS, admins notified
 *   acknowledged → an admin clicked Acknowledge; driver got the
 *                  push confirming help is on the way
 *   closed       → admin recorded an outcome
 *
 * The order's `incidentFlagged` boolean stays true for the customer's
 * tracking banner as long as ANY incident on that order is unclosed.
 */
@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  latitude: number | null;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  longitude: number | null;

  @Index()
  @Column({ type: 'enum', enum: IncidentStatus, default: IncidentStatus.OPEN })
  status: IncidentStatus;

  @Column({ type: 'enum', enum: IncidentOutcome, nullable: true })
  outcome: IncidentOutcome | null;

  @Column({ type: 'text', nullable: true })
  outcomeNote: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone', name: 'raisedAt' })
  raisedAt: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acknowledgedBy: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  closedBy: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
