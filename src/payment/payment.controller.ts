import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { WalletService } from '../wallet/wallet.service';
import { AddFundsDto } from '../wallet/dto/add-funds.dto';
import { PaymentMethod } from '../wallet/entities/transaction.entity';

@ApiTags('Payment')
@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly walletService: WalletService,
  ) {}

  @Post('webhook/paystack')
  @HttpCode(HttpStatus.OK)
  // NFR-S6 / ARCH-11: Paystack can legitimately burst webhook callbacks
  // (one per transaction during high-volume periods, plus retries on
  // delivery failure). Raise the ceiling well above the global 100/min
  // so we never 429 a real callback; the signature check below is the
  // real abuse guard, not the throttler.
  @Throttle({ default: { ttl: 60_000, limit: 1000 } })
  @ApiOperation({ summary: 'Paystack webhook handler (no auth required)' })
  async paystackWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-paystack-signature') signature: string,
  ) {
    const rawBody = req.rawBody;

    if (!rawBody || !signature) {
      throw new UnauthorizedException('Missing signature');
    }

    const isValid = this.paymentService.verifyWebhookSignature(
      rawBody,
      signature,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = this.paymentService.parseWebhookEvent(req.body);

    if (event && event.event === 'payment') {
      const userId = event.metadata?.userId;
      if (userId) {
        try {
          const addFundsDto: AddFundsDto = {
            amount: event.amount,
            paymentMethod: PaymentMethod.BANK_TRANSFER,
            reference: event.reference,
            description: 'Virtual account funding',
          };
          await this.walletService.addFunds(userId, addFundsDto);
          this.logger.log(`Funded wallet for user ${userId}: ₦${event.amount}`);
        } catch (error) {
          this.logger.error(
            `Failed to fund wallet for user ${userId}: ${error}`,
          );
        }
      }
    }

    return { received: true };
  }
}
