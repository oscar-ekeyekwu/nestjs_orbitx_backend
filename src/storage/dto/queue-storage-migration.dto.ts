import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'NotSameProvider', async: false })
class NotSameProvider implements ValidatorConstraintInterface {
  validate(value: string, args: ValidationArguments): boolean {
    const dto = args.object as { fromProviderId?: string };
    return value !== dto.fromProviderId;
  }
  defaultMessage(): string {
    return 'toProviderId must differ from fromProviderId.';
  }
}

/**
 * STG-4 — `POST /admin/storage/migrate` body. The `since` filter is
 * optional; when present, only documents created on or after that
 * timestamp are walked. `dryRun` defaults to false so a careless
 * operator can't accidentally copy half a library without intent.
 */
export class QueueStorageMigrationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  fromProviderId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Validate(NotSameProvider)
  toProviderId: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  batchSize?: number;

  @ApiPropertyOptional({
    description: 'ISO timestamp; only docs created on or after this point.',
  })
  @IsOptional()
  @IsDateString()
  since?: string;
}
