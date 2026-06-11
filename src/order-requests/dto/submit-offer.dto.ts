import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { DispatchOfferType } from '../entities/dispatch-offer.entity';

export class SubmitOfferDto {
  @IsEnum(DispatchOfferType)
  type: DispatchOfferType;

  // Driver's estimated time to reach pickup (seconds). Required for
  // both quote_accept (so the customer sees ETA on the auto-win
  // confirmation) and counter (where it's part of the proposal).
  @IsInt()
  @Min(30)
  @Max(3_600)
  etaSeconds: number;

  // Required when type=COUNTER. Server rejects if absent. Capped via
  // ORDER_REQUEST_COUNTER_MAX_MULTIPLIER + min-multiplier in
  // service-layer logic so we keep the controller dumb.
  @ValidateIf((o: SubmitOfferDto) => o.type === DispatchOfferType.COUNTER)
  @IsNumber()
  @Min(1)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  reason?: string;
}
