import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  DocumentOwnerType,
  DocumentStatus,
  DocumentType,
} from '../entities/document.entity';

/**
 * C2 — query filters for `GET /documents`.
 *
 * Authorization happens in the service: an admin caller sees the full
 * result set across all owners; a non-admin caller has the
 * (ownerType=user, ownerId=<caller>) filter forced regardless of what
 * they pass in, so a driver can never list someone else's docs.
 */
export class ListDocumentsDto {
  @ApiPropertyOptional({ enum: DocumentOwnerType })
  @IsOptional()
  @IsEnum(DocumentOwnerType)
  ownerType?: DocumentOwnerType;

  @ApiPropertyOptional({ example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @ApiPropertyOptional({ enum: DocumentStatus })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  // H5 — narrows to documents whose expiryDate is in the next N days
  // (inclusive of expired-but-within-window). Admin-only filter; ignored
  // for non-admin callers per existing service-side scoping.
  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  expiringInDays?: number;
}
