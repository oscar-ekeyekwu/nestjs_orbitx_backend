import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaymentProviderKind } from '../entities/payment-provider.entity';

/**
 * PAY-1 — admin-side payload for creating a new payment provider.
 * `secretKey` (and optional `webhookSecret`) are plaintext at the API
 * boundary; the service encrypts before persisting. The kind narrows
 * which concrete gateway adapter the registry instantiates.
 */
export class CreatePaymentProviderDto {
  // kebab-case so URLs stay sane (slugs leak into log lines and admin
  // pages). Same convention storage providers use.
  @ApiProperty({ example: 'paystack-main' })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9-]+$/, {
    message:
      'slug must be lowercase alphanumeric + hyphens (e.g. paystack-main)',
  })
  slug: string;

  @ApiProperty({ enum: PaymentProviderKind })
  @IsEnum(PaymentProviderKind)
  kind: PaymentProviderKind;

  @ApiProperty({ example: 'Paystack (Production)' })
  @IsString()
  @Length(1, 128)
  displayName: string;

  @ApiProperty({ example: 'https://api.paystack.co' })
  @IsUrl({ require_tld: false })
  baseUrl: string;

  @ApiPropertyOptional({ example: 'pk_live_…' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  publicKey?: string;

  @ApiPropertyOptional({
    description:
      'Gateway-specific routing hint. For Paystack, the DVA preferred bank slug (wema-bank, access-bank, titan-paystack on live; test-bank on test). Omit to let the adapter auto-pick.',
    example: 'wema-bank',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  preferredBank?: string;

  @ApiProperty({
    description: 'Plaintext secret key — encrypted before persist.',
  })
  @IsString()
  @MinLength(8)
  secretKey: string;

  @ApiPropertyOptional({
    description:
      'Optional dedicated webhook signing secret. When omitted, the gateway uses the main secretKey for HMAC verification.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  webhookSecret?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
