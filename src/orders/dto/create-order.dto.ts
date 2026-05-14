import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  Min,
  Max,
  MinLength,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { PackageSize } from '../entities/order.entity';
import { normalizeNigerianPhone } from '../../common/utils/phone';

const normalizePhone = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = normalizeNigerianPhone(value);
  return normalized ?? value;
};

const E164_NG_REGEX = /^\+234\d{10}$/;

export class CreateOrderDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  pickupLatitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  pickupLongitude: number;

  @IsString()
  @MinLength(5)
  pickupAddress: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  deliveryLatitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  deliveryLongitude: number;

  @IsString()
  @MinLength(5)
  deliveryAddress: string;

  @IsString()
  @MinLength(2)
  recipientName: string;

  @Transform(normalizePhone)
  @IsString()
  @Matches(E164_NG_REGEX, {
    message: 'recipientPhone must be a valid Nigerian phone number',
  })
  recipientPhone: string;

  @IsString()
  @MinLength(3)
  packageDescription: string;

  @IsOptional()
  @IsNumber()
  packageWeight?: number;

  @IsEnum(PackageSize)
  packageSize: PackageSize;

  @IsOptional()
  @IsString()
  deliveryNotes?: string;
}
