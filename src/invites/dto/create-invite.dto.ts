import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * D4 — body for POST /companies/:id/invites.
 *
 * Phone is required and validated against a permissive Nigerian
 * pattern. The SMS dispatch normalizes to E.164 before sending so
 * "+234…", "234…", and "0…" all reach the same handset.
 */
export class CreateInviteDto {
  @ApiProperty({
    example: '+2348012345678',
    description:
      'Driver phone in +234… or 0… format. Stored verbatim; the SMS dispatch normalizes to E.164 at send time.',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\+234\d{10}|234\d{10}|0\d{10})$/, {
    message:
      'Phone must be a valid Nigerian number (+234XXXXXXXXXX, 234XXXXXXXXXX, or 0XXXXXXXXXX).',
  })
  phone: string;
}
