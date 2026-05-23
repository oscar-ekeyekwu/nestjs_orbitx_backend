import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * PAY-1 — partial update on a payment provider. `slug` and `kind` are
 * intentionally immutable after creation (foreign-key audit stability +
 * adapter kind binding). Secrets, when present, replace the existing
 * encrypted blobs; omitting them preserves the current cipher.
 */
export class UpdatePaymentProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 128)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  publicKey?: string | null;

  @ApiPropertyOptional({
    description:
      'Gateway-specific routing hint. For Paystack, the DVA preferred bank slug. Pass null/empty to clear and let the adapter auto-pick.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  preferredBank?: string | null;

  @ApiPropertyOptional({
    description:
      'New plaintext secret key. Omit to keep the existing encrypted secret.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  secretKey?: string;

  @ApiPropertyOptional({
    description:
      'New plaintext webhook secret. Omit to keep the existing webhook secret. Pass empty string to clear it (falls back to main secretKey).',
  })
  @IsOptional()
  @IsString()
  webhookSecret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
