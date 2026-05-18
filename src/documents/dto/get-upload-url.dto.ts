import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { DocumentOwnerType, DocumentType } from '../entities/document.entity';

export class GetUploadUrlDto {
  @ApiProperty({
    enum: DocumentOwnerType,
    example: DocumentOwnerType.USER,
    description: 'Polymorphic owner kind — user, vehicle, or company.',
  })
  @IsEnum(DocumentOwnerType)
  ownerType: DocumentOwnerType;

  @ApiProperty({
    example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88',
    description:
      'Owner id. For ownerType=user this is the user id; for vehicle / company it is the corresponding entity id.',
  })
  @IsUUID()
  ownerId: string;

  @ApiProperty({
    enum: DocumentType,
    example: DocumentType.DRIVERS_LICENSE,
  })
  @IsEnum(DocumentType)
  docType: DocumentType;

  @ApiProperty({
    example: 'image/jpeg',
    description:
      'MIME type the client will PUT with. Must be one of the allowlist (C1). The presigned PUT enforces this content type at the SDK level — sending a different Content-Type header on the PUT will be rejected by S3.',
  })
  @IsString()
  @IsNotEmpty()
  contentType: string;
}
