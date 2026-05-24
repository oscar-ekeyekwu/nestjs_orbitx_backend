import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { AddFundsDto } from './dto/add-funds.dto';
import { WithdrawFundsDto } from './dto/withdraw-funds.dto';
import { TestFundByAccountDto } from './dto/test-fund-by-account.dto';
import { PaymentMethod } from './entities/transaction.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly events: EventEmitter2,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get user wallet' })
  async getWallet(@CurrentUser() user: User) {
    return this.walletService.getWalletByUserId(user.id);
  }

  @Get('balance')
  @ApiOperation({ summary: 'Get wallet balance' })
  async getBalance(@CurrentUser() user: User) {
    const balance = await this.walletService.getBalance(user.id);
    return { balance };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get wallet statistics' })
  async getStats(@CurrentUser() user: User) {
    return this.walletService.getWalletStats(user.id);
  }

  @Get('can-take-order')
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary: 'Check if driver can take orders (balance requirement)',
  })
  async canTakeOrder(@CurrentUser() user: User) {
    const canTake = await this.walletService.canDriverTakeOrder(user.id);
    return { canTakeOrder: canTake };
  }

  @Post('add-funds')
  @ApiOperation({ summary: 'Add funds to wallet' })
  async addFunds(@CurrentUser() user: User, @Body() addFundsDto: AddFundsDto) {
    return this.walletService.addFunds(user.id, addFundsDto);
  }

  @Post('withdraw')
  @ApiOperation({ summary: 'Withdraw funds from wallet' })
  async withdrawFunds(
    @CurrentUser() user: User,
    @Body() withdrawDto: WithdrawFundsDto,
  ) {
    return this.walletService.withdrawFunds(user.id, withdrawDto);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get transaction history' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getTransactions(
    @CurrentUser() user: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.walletService.getTransactions(
      user.id,
      limit || 50,
      offset || 0,
    );
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get transaction by ID' })
  async getTransaction(@Param('id') id: string, @CurrentUser() user: User) {
    return this.walletService.getTransactionById(id, user.id);
  }

  @Get('virtual-account')
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary: 'Get or create virtual bank account for funding wallet',
  })
  async getVirtualAccount(@CurrentUser() user: User) {
    return this.walletService.getOrCreateVirtualAccount(
      user.id,
      user.name ||
        `${user.first_name || ''} ${user.last_name || ''}`.trim() ||
        'Driver',
      user.email,
    );
  }

  @Post('lock/:userId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Lock user wallet (Admin only)' })
  async lockWallet(@Param('userId') userId: string) {
    return this.walletService.lockWallet(userId);
  }

  @Post('unlock/:userId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Unlock user wallet (Admin only)' })
  async unlockWallet(@Param('userId') userId: string) {
    return this.walletService.unlockWallet(userId);
  }

  // Test-only — rehearses the Paystack DVA funding flow without the
  // gateway in the loop. Reuses the exact same wallet credit path the
  // webhook uses (findUserIdByVirtualAccountNumber + addFunds) and
  // emits `wallet.funded` so push + socket fan-out fires identically.
  // Hard-gated to non-production + admin role; refuses to run in prod
  // even if an admin token leaks.
  @Post('test/fund-by-account')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'TEST ONLY — credit a wallet by virtual account number (non-prod, admin).',
  })
  async testFundByAccount(@Body() dto: TestFundByAccountDto) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'Test funding endpoint is disabled in production.',
      );
    }

    const userId = await this.walletService.findUserIdByVirtualAccountNumber(
      dto.accountNumber,
    );
    if (!userId) {
      throw new NotFoundException(
        `No virtual account found for ${dto.accountNumber}.`,
      );
    }

    const reference = `test-fund-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const transaction = await this.walletService.addFunds(userId, {
      amount: dto.amount,
      paymentMethod: PaymentMethod.BANK_TRANSFER,
      reference,
      description: 'TEST — virtual account funding (manual)',
    });

    this.events.emit('wallet.funded', {
      userId,
      amountNaira: dto.amount,
      reference,
    });

    this.logger.warn(
      `TEST funded wallet for user ${userId} via account ${dto.accountNumber}: ₦${dto.amount} (ref=${reference})`,
    );

    return {
      userId,
      reference,
      amountNaira: dto.amount,
      transactionId: transaction.id,
    };
  }
}
