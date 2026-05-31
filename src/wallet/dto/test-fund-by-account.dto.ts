import { IsNumber, IsPositive, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Test-only payload for `POST /wallet/test/fund-by-account`. Mirrors the
 * subset of a Paystack DVA `charge.success` we care about (account
 * number + naira amount) so QA can rehearse the funding flow without
 * Paystack in the loop. Gated to non-production + admin role at the
 * controller layer.
 */
export class TestFundByAccountDto {
  @ApiProperty({
    example: '1234567890',
    description:
      'Virtual account number to credit (looked up in virtual_accounts).',
  })
  @IsString()
  @Length(8, 20)
  accountNumber: string;

  @ApiProperty({
    example: 5000,
    description: 'Amount in naira to credit.',
  })
  @IsNumber()
  @IsPositive()
  amount: number;
}
