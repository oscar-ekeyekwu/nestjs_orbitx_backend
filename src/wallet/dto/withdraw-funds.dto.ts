import { IsNumber, IsPositive, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class WithdrawFundsDto {
  @ApiProperty({
    example: 5000,
    description: 'Amount to withdraw from wallet',
  })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({
    example: 'Withdrawal to bank account',
    description: 'Withdrawal description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'Bank account details or reference',
    description: 'Withdrawal reference',
    required: false,
  })
  @IsOptional()
  @IsString()
  reference?: string;
}
