import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DocumentStatus } from '../entities/document.entity';

/**
 * C5 — admin reviews a pending document. Target status is restricted
 * to approve / reject — the cron owns the `expired` transition.
 */
export class ReviewDocumentDto {
  @ApiProperty({
    enum: [DocumentStatus.APPROVED, DocumentStatus.REJECTED],
    example: DocumentStatus.APPROVED,
    description:
      "Target status. Allowed values are 'approved' or 'rejected'. The cron handles 'expired' on its own schedule.",
  })
  @IsEnum(DocumentStatus, {
    message: 'status must be one of: approved, rejected',
  })
  status: DocumentStatus;

  @ApiProperty({
    example: 'Photo is clear; expiry beyond required window.',
    description:
      'Audit-trail reason captured in approval_decisions. Required for reject; recommended for approve.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
