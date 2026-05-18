import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriversService } from './drivers.service';
import { DriversController } from './drivers.controller';
import { DriverProfile } from './entities/driver-profile.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverProfile, VehicleAssignment, Vehicle]),
    UsersModule,
  ],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
