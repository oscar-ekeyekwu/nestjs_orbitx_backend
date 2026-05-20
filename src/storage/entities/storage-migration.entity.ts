import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum StorageMigrationStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  COMPLETED_WITH_ERRORS = 'completed_with_errors',
}

/**
 * STG-4 — one row per cross-provider migration job.
 *
 * `queuedUntilCreatedAt` is the immutable anchor — the worker only
 * considers documents whose `createdAt <= queuedUntilCreatedAt`, so
 * any KYC upload that lands AFTER the operator hit Start stays on the
 * source provider and is invisible to this migration.
 *
 * `lastDocumentId` is the resume cursor — the worker walks docs in
 * `id ASC` order and updates this field after each successful copy so
 * a pause/resume cycle skips already-migrated rows.
 */
@Entity('storage_migrations')
export class StorageMigration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  fromProviderId: string;

  @Column({ type: 'uuid' })
  toProviderId: string;

  @Index()
  @Column({
    type: 'enum',
    enum: StorageMigrationStatus,
    default: StorageMigrationStatus.QUEUED,
  })
  status: StorageMigrationStatus;

  @Column({ type: 'boolean', default: false })
  dryRun: boolean;

  @Column({ type: 'integer', default: 25 })
  batchSize: number;

  @Column({ type: 'timestamp with time zone', nullable: true })
  since: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  queuedAt: Date;

  @Column({ type: 'timestamp with time zone' })
  queuedUntilCreatedAt: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  totalDocuments: number;

  @Column({ type: 'integer', default: 0 })
  migratedCount: number;

  @Column({ type: 'integer', default: 0 })
  wouldMigrateCount: number;

  @Column({ type: 'integer', default: 0 })
  failedCount: number;

  @Column({ type: 'integer', default: 0 })
  skippedCount: number;

  @Column({ type: 'uuid', nullable: true })
  lastDocumentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  startedBy: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  // STG-5 — stamped on successful completion of the explicit
  // source-delete action. UI uses this to disable the "Delete source
  // copies" button once the step has been performed.
  @Column({ type: 'timestamp with time zone', nullable: true })
  sourceDeletedAt: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone', name: 'createdAt' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
