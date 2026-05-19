import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderShareService } from './order-share.service';
import { OrderShareController } from './order-share.controller';
import { AdminTransfersController } from './admin-transfers.controller';
import { Order } from './entities/order.entity';
import { OrderShareToken } from './entities/order-share-token.entity';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../config/config.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notification.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { VehiclesModule } from '../vehicles/vehicles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderShareToken]),
    UsersModule,
    WalletModule,
    SystemConfigModule,
    // F2 — acceptOrder lazy-resolves VehiclePendingUpdatesService +
    // VehicleAssignmentRepository through ModuleRef to enforce the
    // lock-mode gate. Static import here makes the providers discoverable.
    VehiclesModule,
    // forwardRef because RealtimeModule also imports OrdersModule
    // (gateway calls back into ordersService for driver-location persistence).
    forwardRef(() => RealtimeModule),
    // forwardRef because NotificationsModule imports RealtimeModule, which
    // imports OrdersModule — without this, NotificationsModule resolves to
    // `undefined` here while it is still initializing further up the chain.
    forwardRef(() => NotificationsModule),
    // E4 — receipt pipeline fires on DELIVERED. ReceiptsModule itself
    // imports DocumentsModule + NotificationsModule, both unrelated to
    // the orders/realtime cycle, so a direct import is safe here.
    ReceiptsModule,
  ],
  controllers: [
    OrdersController,
    OrderShareController,
    AdminTransfersController,
  ],
  providers: [OrdersService, OrderShareService],
  exports: [OrdersService],
})
export class OrdersModule {}
