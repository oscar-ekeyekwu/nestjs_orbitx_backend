import { IsOptional, IsString, IsEnum, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UserRole } from '../../common/enums/user-role.enum';
import {
  DriverAccountType,
  DriverVerificationStatus,
} from '../../drivers/entities/driver-profile.entity';

const emptyToUndefined = ({ value }: TransformFnParams): unknown =>
  (value as unknown) || undefined;

export class GetUsersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by name or email' })
  @IsOptional()
  @IsString()
  @Transform(emptyToUndefined)
  search?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Filter by role' })
  @IsOptional()
  @IsEnum(UserRole)
  @Transform(emptyToUndefined)
  role?: UserRole;

  // H3 — driver-profile filters. Joined server-side when role=driver
  // (or implicitly so when any of these are set).
  @ApiPropertyOptional({ enum: DriverAccountType })
  @IsOptional()
  @IsEnum(DriverAccountType)
  @Transform(emptyToUndefined)
  accountType?: DriverAccountType;

  @ApiPropertyOptional({ enum: DriverVerificationStatus })
  @IsOptional()
  @IsEnum(DriverVerificationStatus)
  @Transform(emptyToUndefined)
  verificationStatus?: DriverVerificationStatus;

  @ApiPropertyOptional({
    description: 'Filter to drivers who are members of this company',
  })
  @IsOptional()
  @IsUUID()
  @Transform(emptyToUndefined)
  companyId?: string;
}
