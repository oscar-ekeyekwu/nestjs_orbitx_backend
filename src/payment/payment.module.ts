import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PaystackGateway } from './gateways/paystack.gateway';
import { WalletModule } from '../wallet/wallet.module';
import { Transaction } from '../wallet/entities/transaction.entity';
import { Order } from '../orders/entities/order.entity';

@Module({
  imports: [
    forwardRef(() => WalletModule),
    // ARCH-13 — PaymentService mints + settles its own Transaction
    // rows and looks up Orders for the initialize handshake.
    TypeOrmModule.forFeature([Transaction, Order]),
  ],
  controllers: [PaymentController],
  providers: [
    {
      provide: 'PAYMENT_GATEWAY',
      useClass: PaystackGateway,
    },
    PaymentService,
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
