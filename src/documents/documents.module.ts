import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SpacesStorageService } from './spaces-storage.service';
import { DocumentExpiryCron } from './document-expiry.cron';
import { Document } from './entities/document.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Company } from '../companies/entities/company.entity';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DriversModule } from '../drivers/drivers.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DriverProfile, Vehicle, Company]),
    ApprovalsModule,
    // D1 — the cron's driver-suspend path routes through
    // DriversService.transitionVerification so the audit trail
    // covers system-driven flips too.
    DriversModule,
  ],
  providers: [DocumentsService, SpacesStorageService, DocumentExpiryCron],
  controllers: [DocumentsController],
  exports: [DocumentsService, SpacesStorageService, DocumentExpiryCron],
})
export class DocumentsModule {}
