import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { Company } from './entities/company.entity';
import { ApprovalDecision } from '../approvals/entities/approval-decision.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Company, ApprovalDecision])],
  providers: [CompaniesService],
  controllers: [CompaniesController],
  exports: [CompaniesService],
})
export class CompaniesModule {}
