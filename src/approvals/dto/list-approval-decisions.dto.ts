import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import {
  ApprovalAction,
  ApprovalTargetType,
} from '../entities/approval-decision.entity';

/**
 * C6 — query filters for `GET /approval-decisions`. Admin-only.
 *
 * targetType + targetId together support "show me the full history
 * of this driver / vehicle / company / document". reviewerId answers
 * "show me every decision Adaora has made." action lets compliance
 * pull all rejections for a date range when paired with future
 * decidedFrom / decidedTo filters (deferred to v1.x).
 */
export class ListApprovalDecisionsDto {
  @ApiPropertyOptional({ enum: ApprovalTargetType })
  @IsOptional()
  @IsEnum(ApprovalTargetType)
  targetType?: ApprovalTargetType;

  @ApiPropertyOptional({ example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ example: 'a-uuid-for-admin' })
  @IsOptional()
  @IsUUID()
  reviewerId?: string;

  @ApiPropertyOptional({ enum: ApprovalAction })
  @IsOptional()
  @IsEnum(ApprovalAction)
  action?: ApprovalAction;
}
