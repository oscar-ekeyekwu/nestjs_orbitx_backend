import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { VehicleType } from '../entities/vehicle.entity';

const PLATE_REGEX = /^[A-Za-z0-9-]{4,16}$/;

/**
 * F1 — partial update DTO for the owner-scoped PATCH /vehicles/:id.
 *
 * Every field is optional. Validation only runs on the fields the
 * caller actually included, so a request that only ships
 * `{ color: 'Red' }` does not require the plate or type to be present.
 *
 * The service splits the resulting patch into cosmetic vs regulatory
 * fields. F2 (Sprint 4 next story) wraps the regulatory branch with
 * the pending-update fork; F1 applies both directly.
 */
export class UpdateVehicleDto {
  @ApiProperty({
    enum: VehicleType,
    required: false,
    description: 'Vehicle category. REGULATORY — F2 may fork on change.',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;

  @ApiProperty({
    required: false,
    example: 'LSR-456-XY',
    description: 'Plate number. REGULATORY — F2 may fork on change.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MinLength(4)
  @MaxLength(16)
  @Matches(PLATE_REGEX, {
    message:
      'plate must be 4–16 alphanumeric / hyphen characters (e.g. LSR-456-XY)',
  })
  plate?: string;

  @ApiProperty({
    required: false,
    example: 'Black',
    description: 'Free-text vehicle colour. COSMETIC — applies immediately.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(32)
  color?: string | null;

  @ApiProperty({
    required: false,
    example: 'https://cdn.orbitxng.com/vehicles/a1b2c3.jpg',
    description: 'Public URL of the vehicle photo. COSMETIC.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  photoUrl?: string | null;
}
