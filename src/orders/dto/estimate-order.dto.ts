import { IsEnum, IsNumber, Max, Min } from 'class-validator';
import { PackageSize } from '../entities/order.entity';

/**
 * Lightweight pricing-only payload. Mobile sends this once both
 * addresses are geocoded so the customer sees the actual price
 * (basePrice + distance × perKm) × sizeMultiplier instead of a
 * hardcoded by-size estimate. No side effects — no DB writes, no
 * driver broadcast.
 */
export class EstimateOrderDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  pickupLatitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  pickupLongitude: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  deliveryLatitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  deliveryLongitude: number;

  @IsEnum(PackageSize)
  packageSize: PackageSize;
}
