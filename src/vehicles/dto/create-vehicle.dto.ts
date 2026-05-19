import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { VehicleType } from '../entities/vehicle.entity';

// Nigerian vehicle plates are typically AAA-DDD-AA or AAA-DDDD-AA shapes.
// Loose pattern: 4–10 alphanumeric chars + optional hyphens.
const PLATE_REGEX = /^[A-Za-z0-9-]{4,16}$/;

export class CreateVehicleDto {
  @ApiProperty({
    enum: VehicleType,
    example: VehicleType.MOTORCYCLE,
    description: 'Vehicle category. Drives commission tier + assignment rules.',
  })
  @IsEnum(VehicleType)
  type: VehicleType;

  @ApiProperty({
    example: 'LSR-456-XY',
    description:
      'Plate number. Stored uppercased + unique across the table. The caller need not pre-format.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(16)
  @Matches(PLATE_REGEX, {
    message:
      'plate must be 4–16 alphanumeric / hyphen characters (e.g. LSR-456-XY)',
  })
  plate: string;

  @ApiProperty({
    example: 'Black',
    description: 'Free-text vehicle colour. Optional but recommended.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiProperty({
    example: 'https://cdn.orbitxng.com/vehicles/a1b2c3.jpg',
    description:
      'Public URL of the vehicle photo. Will become a presigned S3 URL once C1 lands.',
    required: false,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  photoUrl?: string;
}
