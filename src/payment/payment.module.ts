import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PaystackGateway } from './gateways/paystack.gateway';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [forwardRef(() => WalletModule)],
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
