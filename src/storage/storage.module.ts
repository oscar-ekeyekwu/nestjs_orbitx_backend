import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalsModule } from '../approvals/approvals.module';
import { SystemConfigModule } from '../config/config.module';
import { Document } from '../documents/entities/document.entity';
import { StorageCryptoService } from './crypto.service';
import { StorageMigrationDeletion } from './entities/storage-migration-deletion.entity';
import { StorageMigrationVerification } from './entities/storage-migration-verification.entity';
import { StorageMigration } from './entities/storage-migration.entity';
import { StorageMigrationFailure } from './entities/storage-migration-failure.entity';
import { StorageProvider } from './entities/storage-provider.entity';
import { StorageMigrationService } from './storage-migration.service';
import { StorageMigrationsController } from './storage-migrations.controller';
import { StorageProvidersController } from './storage-providers.controller';
import { StorageProvidersService } from './storage-providers.service';
import { StorageRegistry } from './storage-registry.service';

/**
 * STG-1 + STG-2 + STG-3 + STG-4 — the platform's only entry-point for
 * object storage.
 *
 * Imports:
 *   - TypeOrmModule.forFeature([StorageProvider, StorageMigration,
 *     StorageMigrationFailure, Document]) — provider CRUD, migration
 *     bookkeeping, and the cross-provider doc walk.
 *   - SystemConfigModule for the active-provider lookup.
 *   - ApprovalsModule for the per-mutation audit-log writes.
 *
 * Exports: StorageRegistry + StorageCryptoService. Concrete adapter
 * classes are construction-only artefacts and intentionally NOT
 * exported — callers always go through the registry.
 *
 * STG-5 will land the verify + source-delete actions alongside the
 * migration service here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StorageProvider,
      StorageMigration,
      StorageMigrationFailure,
      StorageMigrationVerification,
      StorageMigrationDeletion,
      Document,
    ]),
    SystemConfigModule,
    ApprovalsModule,
  ],
  providers: [
    StorageCryptoService,
    StorageRegistry,
    StorageProvidersService,
    StorageMigrationService,
  ],
  controllers: [StorageProvidersController, StorageMigrationsController],
  exports: [StorageRegistry, StorageCryptoService],
})
export class StorageModule {}
