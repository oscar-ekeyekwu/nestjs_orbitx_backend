import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PackageSize } from '../../orders/entities/order.entity';

export class CreateOrderRequestDto {
  @IsLatitude()
  pickupLatitude: number;

  @IsLongitude()
  pickupLongitude: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  pickupAddress: string;

  @IsLatitude()
  deliveryLatitude: number;

  @IsLongitude()
  deliveryLongitude: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  deliveryAddress: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  recipientName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  recipientPhone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  packageDescription: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999)
  packageWeight?: number;

  @IsEnum(PackageSize)
  packageSize: PackageSize;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  deliveryNotes?: string;
}
