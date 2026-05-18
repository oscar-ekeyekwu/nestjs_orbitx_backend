import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { DocumentOwnerType, DocumentType } from '../entities/document.entity';

/**
 * C1 — body for `POST /documents`. The client calls this after a
 * successful PUT to the presigned upload-url, handing back the
 * `objectKey` we returned earlier. The backend HEADs Spaces to verify
 * the bytes actually landed before persisting the metadata row, so
 * stale upload-urls or aborted uploads never produce orphaned rows.
 */
export class CreateDocumentDto {
  @ApiProperty({ enum: DocumentOwnerType, example: DocumentOwnerType.USER })
  @IsEnum(DocumentOwnerType)
  ownerType: DocumentOwnerType;

  @ApiProperty({ example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88' })
  @IsUUID()
  ownerId: string;

  @ApiProperty({ enum: DocumentType, example: DocumentType.DRIVERS_LICENSE })
  @IsEnum(DocumentType)
  docType: DocumentType;

  @ApiProperty({
    example: 'user/b6f1.../drivers_license/3e8c....jpg',
    description:
      'Object key returned by POST /documents/upload-url. The backend HEADs Spaces to confirm the upload landed before persisting the row.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  fileKey: string;

  @ApiPropertyOptional({
    example: '2027-03-15',
    description:
      'Optional document expiry (date-only, YYYY-MM-DD). Drives the expiry cron in C4.',
  })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}
