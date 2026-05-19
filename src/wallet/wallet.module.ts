import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletService } from './wallet.service';
import { WalletReconcileService } from './wallet-reconcile.service';
import { WalletReconcileCron } from './wallet-reconcile.cron';
import { WalletController } from './wallet.controller';
import { Wallet } from './entities/wallet.entity';
import { Transaction } from './entities/transaction.entity';
import { VirtualAccount } from './entities/virtual-account.entity';
import { SystemConfigModule } from '../config/config.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet, Transaction, VirtualAccount]),
    SystemConfigModule,
    forwardRef(() => PaymentModule),
  ],
  providers: [WalletService, WalletReconcileService, WalletReconcileCron],
  controllers: [WalletController],
  exports: [WalletService, WalletReconcileService],
})
export class WalletModule {}
