import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Headers,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    private readonly events: EventEmitter2,
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

  // G1 — manual verify after the mobile WebView's hosted-page callback.
  // Customers can only verify their own transactions; admins (e.g. for
  // ops triage) can verify any reference.
  @Get('verify/:reference')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Verify a Paystack reference. Compensates for missed webhooks; idempotent.',
  })
  async verify(
    @Param('reference') reference: string,
    @CurrentUser() user: User,
  ) {
    if (user.role !== UserRole.CUSTOMER && user.role !== UserRole.ADMIN) {
      throw new BadRequestException('Only customers or admins can verify.');
    }
    return this.paymentService.verifyOrderPayment(reference, {
      id: user.id,
      role: user.role as 'customer' | 'admin',
    });
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

    const isValid = await this.paymentService.verifyWebhookSignature(
      rawBody,
      signature,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = await this.paymentService.parseWebhookEvent(req.body);
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

    // Virtual-account funding path. Paystack DVA charge.success
    // events don't carry our userId on `charge.metadata`; the
    // gateway parser already lifts it from `customer.metadata` and
    // forwards `receiverAccountNumber` for accounts where the
    // customer-metadata copy isn't reliable. We try each signal in
    // order so attribution survives different Paystack payload
    // shapes.
    if (event.kind === 'payment') {
      const userId = await this.resolveFundingUserId(event.metadata);
      if (!userId) {
        this.logger.warn(
          `Paystack payment.success ref=${event.reference} could not be attributed to a user (no metadata.userId, customerCode, or receiverAccountNumber match). Dropping.`,
        );
        return { received: true };
      }
      try {
        const addFundsDto: AddFundsDto = {
          amount: event.amount,
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          reference: event.reference,
          description: 'Virtual account funding',
        };
        await this.walletService.addFunds(userId, addFundsDto);
        this.logger.log(`Funded wallet for user ${userId}: ₦${event.amount}`);
        // Post-commit fan-out: push notification + socket nudge so the
        // mobile wallet refreshes without pull-to-refresh. Both are
        // best-effort — failures here MUST NOT 5xx the webhook (or
        // Paystack will retry and we'd double-fund — `addFunds` is
        // reference-idempotent so a retry is technically safe, but
        // still noisy).
        this.events.emit('wallet.funded', {
          userId,
          amountNaira: event.amount,
          reference: event.reference,
        });
      } catch (error) {
        this.logger.error(
          `Failed to fund wallet for user ${userId}: ${error}`,
        );
      }
    }

    return { received: true };
  }

  /**
   * Walk the metadata signals in attribution-confidence order:
   *   1. Charge-level userId (server-issued reference, very rare for DVA)
   *   2. Customer-level userId (we tagged the customer at create-time)
   *   3. Receiving DVA account number → look up in virtual_accounts
   *
   * Returns null when nothing matches; the caller logs + drops the
   * event. Test webhooks and DVAs created outside our backend land
   * here.
   */
  private async resolveFundingUserId(
    metadata: { [key: string]: unknown } | undefined,
  ): Promise<string | null> {
    if (!metadata) return null;
    const direct = typeof metadata.userId === 'string' ? metadata.userId : null;
    if (direct) return direct;
    const accountNumber =
      typeof metadata.receiverAccountNumber === 'string'
        ? metadata.receiverAccountNumber
        : null;
    if (accountNumber) {
      const owner =
        await this.walletService.findUserIdByVirtualAccountNumber(
          accountNumber,
        );
      if (owner) return owner;
    }
    return null;
  }
}
