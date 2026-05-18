import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { VehicleStatus } from '../entities/vehicle.entity';

export class UpdateVehicleStatusDto {
  @ApiProperty({
    enum: VehicleStatus,
    example: VehicleStatus.APPROVED,
    description:
      'Target status. Must be an edge in vehicleStateMachine — e.g. pending_approval → approved | rejected, approved → active | suspended | retired.',
  })
  @IsEnum(VehicleStatus)
  status: VehicleStatus;

  @ApiProperty({
    example: 'Photos match registration; insurance valid until 2026-12-31.',
    description:
      'Audit-trail reason captured in approval_decisions. Required for rejection / suspension; recommended for approval.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
