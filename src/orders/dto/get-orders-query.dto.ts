import { IsOptional, IsEnum, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { OrderStatus } from '../entities/order.entity';

const emptyToUndefined = ({ value }: TransformFnParams): unknown =>
  (value as unknown) || undefined;

export class GetOrdersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: OrderStatus, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(OrderStatus)
  @Transform(emptyToUndefined)
  status?: OrderStatus;

  // Admin-only filter — scopes to orders dispatched to this driver.
  // Honoured server-side only when the caller is an admin; drivers
  // are already pinned to their own userId in findAll.
  @ApiPropertyOptional({ description: 'Filter by driver user id (admin only)' })
  @IsOptional()
  @IsUUID()
  @Transform(emptyToUndefined)
  driverId?: string;
}
