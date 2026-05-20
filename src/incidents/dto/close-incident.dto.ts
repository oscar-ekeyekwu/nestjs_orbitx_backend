import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IncidentOutcome } from '../entities/incident.entity';

export class CloseIncidentDto {
  @ApiProperty({ enum: IncidentOutcome })
  @IsEnum(IncidentOutcome)
  outcome: IncidentOutcome;

  @ApiProperty({
    example: 'Driver was rear-ended; tow contacted, no injuries.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  outcomeNote: string;
}
