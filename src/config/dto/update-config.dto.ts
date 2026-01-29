import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateConfigDto {
  @ApiProperty({
    example: 'DRIVER_MIN_BALANCE',
    description: 'Configuration key',
  })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({
    example: '5000',
    description: 'Configuration value',
  })
  @IsString()
  @IsNotEmpty()
  value: string;

  @ApiProperty({
    example: 'Minimum balance required for drivers to accept orders',
    description: 'Description of the configuration',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'number',
    description: 'Data type of the configuration value',
    enum: ['string', 'number', 'boolean', 'json'],
  })
  @IsEnum(['string', 'number', 'boolean', 'json'])
  dataType: 'string' | 'number' | 'boolean' | 'json';
}
