import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CompanyStatus } from '../entities/company.entity';

export class UpdateCompanyStatusDto {
  @ApiProperty({
    enum: CompanyStatus,
    example: CompanyStatus.APPROVED,
    description:
      'Target status. The transition must be allowed by companyStateMachine — e.g. pending → approved, approved ↔ suspended.',
  })
  @IsEnum(CompanyStatus)
  status: CompanyStatus;

  @ApiProperty({
    example: 'Documents verified — CAC and TIN cross-checked.',
    description:
      'Audit-trail reason captured in approval_decisions. Required for suspension/rejection; recommended for approval.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
