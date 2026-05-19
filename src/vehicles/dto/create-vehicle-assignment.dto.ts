import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateVehicleAssignmentDto {
  @ApiProperty({
    example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88',
    description:
      'driver_profiles.id of the driver to assign. Must be a member of the caller`s company unless caller is an admin.',
  })
  @IsUUID()
  driverId: string;

  @ApiProperty({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description:
      'vehicles.id of the vehicle to assign. Must be company-owned, status=approved, and currently unassigned.',
  })
  @IsUUID()
  vehicleId: string;
}
