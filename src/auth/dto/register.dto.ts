import {
  IsEmail,
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { UserRole } from '../../common/enums/user-role.enum';
import { ApiProperty } from '@nestjs/swagger';
import { normalizeNigerianPhone } from '../../common/utils/phone';

// Coerce common local formats (08123456789, 8123456789, 2348..., +234...)
// into strict E.164 +234XXXXXXXXXX before validation runs. If we can't
// normalize, leave the value alone so @Matches surfaces a clean error.
const normalizePhone = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = normalizeNigerianPhone(value);
  return normalized ?? value;
};

const E164_NG_REGEX = /^\+234\d{10}$/;

export class RegisterDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address',
  })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'John', description: 'First name of the user' })
  @IsString()
  @MinLength(2)
  first_name: string;

  @ApiProperty({ example: 'Doe', description: 'Last name of the user' })
  @IsString()
  @MinLength(2)
  last_name: string;

  @ApiProperty({ example: '****', description: 'Password of the user' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'customer', description: 'Role of the user' })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({
    example: '+2348123456789',
    description:
      'Nigerian phone number. Accepts local (08123456789) or international (+2348123456789); normalized to E.164.',
  })
  @IsOptional()
  @Transform(normalizePhone)
  @IsString()
  @Matches(E164_NG_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  phone?: string;
}
