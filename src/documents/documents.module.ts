import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SpacesStorageService } from './spaces-storage.service';
import { Document } from './entities/document.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Document])],
  providers: [DocumentsService, SpacesStorageService],
  controllers: [DocumentsController],
  exports: [DocumentsService, SpacesStorageService],
})
export class DocumentsModule {}
