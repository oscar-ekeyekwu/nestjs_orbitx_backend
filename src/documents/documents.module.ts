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

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DriverProfile, Vehicle, Company]),
    ApprovalsModule,
  ],
  providers: [DocumentsService, SpacesStorageService, DocumentExpiryCron],
  controllers: [DocumentsController],
  exports: [DocumentsService, SpacesStorageService, DocumentExpiryCron],
})
export class DocumentsModule {}
