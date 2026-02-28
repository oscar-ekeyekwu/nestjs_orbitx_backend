import { IsOptional, IsString, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UserRole } from '../../common/enums/user-role.enum';

export class GetUsersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by name or email' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => value || undefined)
  search?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Filter by role' })
  @IsOptional()
  @IsEnum(UserRole)
  @Transform(({ value }) => value || undefined)
  role?: UserRole;
}
