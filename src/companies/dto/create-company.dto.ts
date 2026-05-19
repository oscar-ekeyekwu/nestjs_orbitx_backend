import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({
    example: 'Adebayo Logistics Limited',
    description: 'Legal / CAC-registered name of the company',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  legalName: string;

  @ApiProperty({
    example: 'RC123456',
    description: 'Corporate Affairs Commission registration number',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cacNumber?: string;

  @ApiProperty({
    example: '12345678-0001',
    description: 'Tax Identification Number',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tin?: string;

  @ApiProperty({
    example: '12 Awolowo Road, Ikoyi, Lagos',
    description: 'Registered head-office address',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}
