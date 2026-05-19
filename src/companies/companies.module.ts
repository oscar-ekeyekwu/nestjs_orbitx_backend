import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyMembershipsController } from './company-memberships.controller';
import { CompanyMembershipsService } from './company-memberships.service';
import { Company } from './entities/company.entity';
import { CompanyMembership } from './entities/company-membership.entity';
import { ApprovalDecision } from '../approvals/entities/approval-decision.entity';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      CompanyMembership,
      ApprovalDecision,
      DriverProfile,
    ]),
    ApprovalsModule,
  ],
  providers: [CompaniesService, CompanyMembershipsService],
  controllers: [CompaniesController, CompanyMembershipsController],
  exports: [CompaniesService, CompanyMembershipsService],
})
export class CompaniesModule {}
