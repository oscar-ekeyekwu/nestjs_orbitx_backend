import { IsOptional, IsString, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UserRole } from '../../common/enums/user-role.enum';

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
}
