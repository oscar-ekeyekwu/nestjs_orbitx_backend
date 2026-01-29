import { IsNumber, IsPositive, IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/transaction.entity';

export class AddFundsDto {
  @ApiProperty({
    example: 5000,
    description: 'Amount to add to wallet',
  })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({
    example: 'cash',
    description: 'Payment method',
    enum: PaymentMethod,
  })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @ApiProperty({
    example: 'Top up from cash payment',
    description: 'Transaction description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'REF123456',
    description: 'Payment reference',
    required: false,
  })
  @IsOptional()
  @IsString()
  reference?: string;
}
