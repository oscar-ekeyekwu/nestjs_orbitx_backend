import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalsModule } from '../approvals/approvals.module';
import { SystemConfigModule } from '../config/config.module';
import { StorageModule } from '../storage/storage.module';
import { Order } from '../orders/entities/order.entity';
import { Transaction } from '../wallet/entities/transaction.entity';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentGatewayRegistry } from './payment-gateway.registry';
import { PaymentProvider } from './entities/payment-provider.entity';
import { PaymentProvidersController } from './payment-providers.controller';
import { PaymentProvidersService } from './payment-providers.service';

@Module({
  imports: [
    forwardRef(() => WalletModule),
    // ARCH-13 — PaymentService mints + settles its own Transaction
    // rows and looks up Orders for the initialize handshake. PAY-1
    // adds PaymentProvider — the credential-bearing rows the registry
    // reads to instantiate a gateway adapter at request time.
    TypeOrmModule.forFeature([Transaction, Order, PaymentProvider]),
    // SystemConfig — registry reads payment.activeProviderId.
    SystemConfigModule,
    // StorageModule exports StorageCryptoService which encrypts /
    // decrypts the payment_provider secret blobs with the shared
    // STORAGE_KEK. ApprovalsModule provides the audit-ledger writer
    // used by the admin CRUD endpoints.
    StorageModule,
    ApprovalsModule,
  ],
  controllers: [PaymentController, PaymentProvidersController],
  providers: [PaymentService, PaymentGatewayRegistry, PaymentProvidersService],
  // PaymentService stays exported for the wallet flows that consume it.
  // PaymentGatewayRegistry is exported so PayoutsService can resolve
  // the active gateway too.
  exports: [PaymentService, PaymentGatewayRegistry],
})
export class PaymentModule {}
