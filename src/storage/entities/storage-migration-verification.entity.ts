import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum StorageMigrationVerificationStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  COMPLETED_WITH_GAPS = 'completed_with_gaps',
}

/**
 * STG-5 — one row per verify pass against a finished migration. Each
 * run iterates every document moved by the migration and tallies
 * matches (`verifiedCount`) vs gaps (`missingAtDestination`). The
 * presence of any gaps blocks the delete-source action.
 */
@Entity('storage_migration_verifications')
export class StorageMigrationVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  migrationId: string;

  @Column({
    type: 'timestamp with time zone',
    default: () => 'now()',
  })
  startedAt: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt: Date | null;

  @Column({
    type: 'enum',
    enum: StorageMigrationVerificationStatus,
    default: StorageMigrationVerificationStatus.RUNNING,
  })
  status: StorageMigrationVerificationStatus;

  @Column({ type: 'integer', default: 0 })
  verifiedCount: number;

  @Column({ type: 'integer', default: 0 })
  missingAtDestination: number;

  @Column({ type: 'integer', default: 0 })
  totalChecked: number;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
