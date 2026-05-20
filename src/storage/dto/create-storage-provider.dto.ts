import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { StorageProviderKind } from '../entities/storage-provider.entity';

/**
 * STG-2 — body for `POST /admin/storage/providers`.
 *
 * `slug` is immutable post-create (PATCH rejects it) so the audit
 * trail keyed by slug stays stable. Matches `^[a-z0-9][a-z0-9-]{2,63}$`
 * — a permissive subdomain-ish shape that's safe to put in URLs, logs,
 * and CI scripts without escaping.
 */
export class CreateStorageProviderDto {
  @ApiProperty({ example: 'supabase-eu-central' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9][a-z0-9-]{2,63}$/, {
    message:
      'slug must match /^[a-z0-9][a-z0-9-]{2,63}$/ (lowercase, digits, hyphens; 3–64 chars).',
  })
  slug: string;

  @ApiPropertyOptional({
    enum: StorageProviderKind,
    default: StorageProviderKind.S3_COMPATIBLE,
  })
  @IsOptional()
  @IsEnum(StorageProviderKind)
  kind?: StorageProviderKind;

  @ApiProperty({ example: 'Supabase Storage (EU Central)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  displayName: string;

  @ApiProperty({
    example: 'https://abcdefghij.supabase.co/storage/v1/s3',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  endpoint: string;

  @ApiProperty({ example: 'eu-central-1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  region: string;

  @ApiProperty({ example: 'kyc-v1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  bucket: string;

  @ApiProperty({ example: 'AKIAIOSFODNN7EXAMPLE' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  accessKeyId: string;

  @ApiProperty({
    description:
      'Plaintext S3 secret access key. Encrypted server-side via STORAGE_KEK before persistence. Never echoed back in any response.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  secretAccessKey: string;
}
