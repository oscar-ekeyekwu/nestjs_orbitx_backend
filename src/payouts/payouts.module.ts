import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PayoutsService } from './payouts.service';
import { PayoutsCron } from './payouts.cron';
import { PayoutsAdminController } from './payouts.controller';
import { Payout } from './entities/payout.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { User } from '../users/entities/user.entity';
import { SystemConfigModule } from '../config/config.module';
import { PaymentModule } from '../payment/payment.module';

/**
 * G4 — payouts pipeline. Owns the weekly cron, the manual disbursement
 * admin endpoints, and the gateway-fanned auto-transfer settlement.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Payout, Wallet, User]),
    SystemConfigModule,
    // PaymentModule exports the PaymentGatewayRegistry that PayoutsService
    // injects to resolve the currently-active gateway per request.
    PaymentModule,
  ],
  providers: [PayoutsService, PayoutsCron],
  controllers: [PayoutsAdminController],
  exports: [PayoutsService],
})
export class PayoutsModule {}
