import {
  IsOptional,
  IsEmail,
  IsString,
  IsBoolean,
  MaxLength,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { normalizeNigerianPhone } from '../../common/utils/phone';

// Same normalization as RegisterDto — coerce local formats to strict
// E.164 +234XXXXXXXXXX before @Matches runs.
const normalizePhone = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = normalizeNigerianPhone(value);
  return normalized ?? value;
};

const E164_NG_REGEX = /^\+234\d{10}$/;

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  first_name?: string;

  @IsOptional()
  @IsString()
  last_name?: string;

  @IsOptional()
  @Transform(normalizePhone)
  @IsString()
  @Matches(E164_NG_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  phone?: string;

  /**
   * URL of the profile picture stored in the platform's image
   * adapter. The mobile client uploads to POST /upload/image first,
   * then PATCH /users/me with the returned URL. Empty string clears
   * the existing avatar.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  avatar?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
