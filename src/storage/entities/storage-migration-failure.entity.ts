import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * STG-4 — per-document failure row, recorded after a doc copy exhausts
 * its retry budget (3 attempts at 1s / 4s / 16s backoff). Each row
 * names the document, the final attempt count, and the sanitised
 * error message. Surfaced inline on the admin migration detail page.
 */
@Entity('storage_migration_failures')
export class StorageMigrationFailure {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  migrationId: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @Column({ type: 'text' })
  errorMessage: string;

  @Column({ type: 'smallint', default: 1 })
  attempt: number;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;
}
