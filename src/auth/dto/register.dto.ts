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
import { DriverAccountType } from '../../drivers/entities/driver-profile.entity';
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

  // D4 — driver_invite token captured from the SMS deep link. When
  // present, AuthService.register redeems it inside the same
  // transaction that creates the User + DriverProfile and links the
  // new driver to the inviting company. Role is automatically
  // narrowed to DRIVER + accountType=company_employee.
  @ApiProperty({
    example: 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88',
    description:
      'Optional driver invite token. If provided, the new driver is pre-linked to the inviting company and the invite is marked used.',
    required: false,
  })
  @IsOptional()
  @IsString()
  inviteToken?: string;

  // Lets the register screen distinguish individual drivers from company
  // owners up front. Only meaningful when role=driver; the service
  // ignores it for customers and refuses company_employee here (that
  // bucket is reserved for the invite flow, which sets it server-side).
  @ApiProperty({
    enum: DriverAccountType,
    example: DriverAccountType.INDIVIDUAL,
    description:
      'Optional driver account type. Only used when role=driver. company_employee is rejected here — use the invite flow instead.',
    required: false,
  })
  @IsOptional()
  @IsEnum(DriverAccountType)
  accountType?: DriverAccountType;
}
