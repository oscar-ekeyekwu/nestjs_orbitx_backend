import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../config/config.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order]),
    UsersModule,
    WalletModule,
    SystemConfigModule,
    // forwardRef because RealtimeModule also imports OrdersModule
    // (gateway calls back into ordersService for driver-location persistence).
    forwardRef(() => RealtimeModule),
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
