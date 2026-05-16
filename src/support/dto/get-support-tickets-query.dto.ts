import { IsOptional, IsEnum, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  SupportTicketStatus,
  SupportTicketPriority,
} from '../entities/support-ticket.entity';

export class GetSupportTicketsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ enum: SupportTicketPriority })
  @IsOptional()
  @IsEnum(SupportTicketPriority)
  priority?: SupportTicketPriority;

  @ApiPropertyOptional({ description: 'Substring match on subject or description' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
