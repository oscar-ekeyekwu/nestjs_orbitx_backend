import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { WalletService } from '../wallet/wallet.service';
import { AddFundsDto } from '../wallet/dto/add-funds.dto';
import { PaymentMethod } from '../wallet/entities/transaction.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';

class InitializePaymentDto {
  @IsUUID()
  orderId!: string;
}

@ApiTags('Payment')
@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly walletService: WalletService,
  ) {}

  // ARCH-13 — customer initializes a Paystack hosted-page charge for
  // their order. Backend mints a pending Transaction and hands its id
  // back as `reference`; the webhook closes the loop.
  @Post('initialize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initialize a Paystack charge for an order' })
  async initialize(
    @Body() dto: InitializePaymentDto,
    @CurrentUser() user: User,
  ) {
    if (!user.email) {
      throw new BadRequestException('Customer email required for Paystack.');
    }
    return this.paymentService.initializeOrderPayment(
      dto.orderId,
      user.id,
      user.email,
    );
  }

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
    if (!event) return { received: true };

    // ARCH-13 — order-bound charge.success: settle the pre-minted
    // Transaction row and credit the wallet under pessimistic_write.
    // Idempotent on reference; replays are no-ops.
    if (event.kind === 'charge_succeeded') {
      try {
        await this.paymentService.settleSuccessfulCharge(event.reference);
        this.logger.log(`Settled Paystack charge ${event.reference}`);
      } catch (err) {
        this.logger.error(`Failed to settle charge ${event.reference}: ${err}`);
      }
      return { received: true };
    }

    if (event.kind === 'charge_failed') {
      try {
        await this.paymentService.markChargeFailed(event.reference);
      } catch (err) {
        this.logger.error(
          `Failed to mark charge ${event.reference} as failed: ${err}`,
        );
      }
      return { received: true };
    }

    // Legacy virtual-account funding path — unchanged.
    if (event.kind === 'payment') {
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
