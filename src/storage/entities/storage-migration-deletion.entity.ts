import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum StorageMigrationDeletionStatus {
  DELETED = 'deleted',
  SKIPPED_MISSING_AT_DESTINATION = 'skipped_missing_at_destination',
  FAILED = 'failed',
}

/**
 * STG-5 — one row per document touched by the source-delete action.
 * `status` discriminates the three terminal outcomes per the spec:
 *   deleted: source object removed via `srcAdapter.delete(key)`.
 *   skipped_missing_at_destination: destination copy not present at
 *     re-verify time; defense against drift between verify + delete.
 *   failed: delete threw on the source provider (network / auth / etc).
 */
@Entity('storage_migration_deletions')
export class StorageMigrationDeletion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  migrationId: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @Column({
    type: 'enum',
    enum: StorageMigrationDeletionStatus,
  })
  status: StorageMigrationDeletionStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  deletedAt: Date;
}
