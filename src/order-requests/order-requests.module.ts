import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderRequest } from './entities/order-request.entity';
import { DispatchOffer } from './entities/dispatch-offer.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderRequestsService } from './order-requests.service';
import { OrderRequestsController } from './order-requests.controller';
import { OrderRequestsExpiryCron } from './order-requests.cron';
import { OrdersModule } from '../orders/orders.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../config/config.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([OrderRequest, DispatchOffer, Order]),
    forwardRef(() => OrdersModule),
    WalletModule,
    SystemConfigModule,
    forwardRef(() => RealtimeModule),
  ],
  controllers: [OrderRequestsController],
  providers: [OrderRequestsService, OrderRequestsExpiryCron],
  exports: [OrderRequestsService],
})
export class OrderRequestsModule {}
