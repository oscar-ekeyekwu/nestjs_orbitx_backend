import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentExpiryCron } from './document-expiry.cron';
import { Document } from './entities/document.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Company } from '../companies/entities/company.entity';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DriversModule } from '../drivers/drivers.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Document,
      DriverProfile,
      Vehicle,
      VehicleAssignment,
      Company,
    ]),
    ApprovalsModule,
    // D1 — the cron's driver-suspend path routes through
    // DriversService.transitionVerification so the audit trail
    // covers system-driven flips too.
    DriversModule,
    // STG-1 — replaces the inline SpacesStorageService. DocumentsService
    // talks to the StorageRegistry; the registry resolves a per-provider
    // adapter from the `storage_providers` table on every call.
    StorageModule,
  ],
  providers: [DocumentsService, DocumentExpiryCron],
  controllers: [DocumentsController],
  exports: [DocumentsService, DocumentExpiryCron],
})
export class DocumentsModule {}
