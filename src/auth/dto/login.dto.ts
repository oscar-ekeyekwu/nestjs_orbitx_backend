import { IsString, IsEmail, ValidateIf, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
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

export class LoginDto {
  @ApiProperty({
    example: 'user@example.com',
    description:
      'Email address. Provide exactly one of email or phone, not both.',
    required: false,
  })
  @ValidateIf((o: LoginDto) => !o.phone)
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: '+2348123456789',
    description:
      'Nigerian phone number. Provide exactly one of email or phone, not both.',
    required: false,
  })
  @ValidateIf((o: LoginDto) => !o.email)
  @Transform(normalizePhone)
  @IsString()
  @Matches(E164_NG_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  phone?: string;

  @ApiProperty({ example: '****', description: 'Password of the user' })
  @IsString()
  password: string;
}
