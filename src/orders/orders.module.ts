import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderShareService } from './order-share.service';
import { OrderShareController } from './order-share.controller';
import { Order } from './entities/order.entity';
import { OrderShareToken } from './entities/order-share-token.entity';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../config/config.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderShareToken]),
    UsersModule,
    WalletModule,
    SystemConfigModule,
    // forwardRef because RealtimeModule also imports OrdersModule
    // (gateway calls back into ordersService for driver-location persistence).
    forwardRef(() => RealtimeModule),
    // forwardRef because NotificationsModule imports RealtimeModule, which
    // imports OrdersModule — without this, NotificationsModule resolves to
    // `undefined` here while it is still initializing further up the chain.
    forwardRef(() => NotificationsModule),
  ],
  controllers: [OrdersController, OrderShareController],
  providers: [OrdersService, OrderShareService],
  exports: [OrdersService],
})
export class OrdersModule {}
