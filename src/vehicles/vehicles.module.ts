import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { VehicleAssignmentsController } from './vehicle-assignments.controller';
import { VehicleAssignmentsService } from './vehicle-assignments.service';
import { Vehicle } from './entities/vehicle.entity';
import { VehicleAssignment } from './entities/vehicle-assignment.entity';
import { ApprovalDecision } from '../approvals/entities/approval-decision.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { Company } from '../companies/entities/company.entity';
import { CompaniesModule } from '../companies/companies.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Vehicle,
      VehicleAssignment,
      ApprovalDecision,
      DriverProfile,
      Company,
    ]),
    // CompanyMembershipsService is consumed by VehicleAssignmentsService
    // for the "driver must be an approved member" check.
    CompaniesModule,
    ApprovalsModule,
  ],
  providers: [VehiclesService, VehicleAssignmentsService],
  controllers: [VehiclesController, VehicleAssignmentsController],
  exports: [VehiclesService, VehicleAssignmentsService],
})
export class VehiclesModule {}
