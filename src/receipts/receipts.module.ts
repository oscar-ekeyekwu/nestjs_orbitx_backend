import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/entities/order.entity';
import { DocumentsModule } from '../documents/documents.module';
import { NotificationsModule } from '../notifications/notification.module';
import { ReceiptsService } from './receipts.service';

/**
 * E4 — receipts pipeline. Owns nothing of its own beyond ReceiptsService;
 * imports orders (for the Order entity), documents (for the shared
 * SpacesStorageService — same private bucket the KYC pipeline uses,
 * scoped via `receipts/` prefix), and notifications (for email + SMS).
 *
 * NotificationsModule is forwardRef'd because the broader module graph
 * forms a cycle: NotificationsModule -> RealtimeModule -> OrdersModule
 * -> ReceiptsModule -> NotificationsModule. Without the deferral, the
 * NotificationsModule symbol is `undefined` here while it is still
 * mid-initialization further up the chain.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Order]),
    DocumentsModule,
    forwardRef(() => NotificationsModule),
  ],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
