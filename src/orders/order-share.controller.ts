import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrderShareService } from './order-share.service';

/**
 * E3 — public read-only tracking. No auth guard: anyone with the token
 * can read the stripped snapshot, but the snapshot itself contains no
 * PII (no addresses, no phones, no customer details — just stages,
 * driver first name, and ETA).
 *
 * Mounted at /track to keep the URL short for SMS / WhatsApp sharing.
 * The browser-facing share URL points the visitor at the admin
 * frontend's `/track/<token>` page, which calls this endpoint.
 */
@ApiTags('Track')
@Controller('track')
export class OrderShareController {
  constructor(private readonly orderShareService: OrderShareService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Public read-only order tracking snapshot' })
  resolveToken(@Param('token') token: string) {
    return this.orderShareService.resolveToken(token);
  }
}
