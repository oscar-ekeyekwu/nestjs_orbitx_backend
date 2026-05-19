import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { CompanyMembershipStatus } from '../entities/company-membership.entity';

export class UpdateCompanyMembershipStatusDto {
  @ApiProperty({
    enum: CompanyMembershipStatus,
    example: CompanyMembershipStatus.APPROVED,
    description:
      'Target membership status. Transitions: pending → approved | removed, approved → removed.',
  })
  @IsEnum(CompanyMembershipStatus)
  status: CompanyMembershipStatus;
}
