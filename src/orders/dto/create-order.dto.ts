import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { PackageSize } from '../entities/order.entity';

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

  @IsString()
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
