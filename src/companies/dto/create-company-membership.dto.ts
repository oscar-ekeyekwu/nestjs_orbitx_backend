import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { CompanyMembershipRole } from '../entities/company-membership.entity';

export class CreateCompanyMembershipDto {
  @ApiProperty({
    example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88',
    description:
      'driver_profiles.id of the driver being invited. The driver row must already exist (registration handles that).',
  })
  @IsUUID()
  driverId: string;

  @ApiProperty({
    enum: CompanyMembershipRole,
    example: CompanyMembershipRole.EMPLOYEE,
    description:
      'Membership role. owner privileges can only be granted by an admin in v1.',
    required: false,
  })
  @IsOptional()
  @IsEnum(CompanyMembershipRole)
  role?: CompanyMembershipRole;
}
