import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { Vehicle } from './entities/vehicle.entity';
import { ApprovalDecision } from '../approvals/entities/approval-decision.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vehicle, ApprovalDecision, DriverProfile]),
  ],
  providers: [VehiclesService],
  controllers: [VehiclesController],
  exports: [VehiclesService],
})
export class VehiclesModule {}
