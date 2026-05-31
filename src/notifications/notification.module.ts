import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notification.service';
import { NotificationsController } from './notification.controller';
import { NotificationTemplateAdminController } from './notification-template.admin.controller';
import { NotificationTemplateService } from './notification-template.service';
import { PushNotificationService } from './push-notification.service';
import { PushFanoutService } from './push-fanout.service';
import { PushFanoutEventSubscribers } from './push-fanout.subscribers';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { Notification } from './entities/notification.entity';
import { NotificationTemplate } from './entities/notification-template.entity';
import { DeviceToken } from './entities/device-token.entity';
import { DeviceTokensService } from './device-tokens.service';
import { DeviceTokensController } from './device-tokens.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { SystemConfigModule } from '../config/config.module';
import { User } from '../users/entities/user.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { Wallet } from '../wallet/entities/wallet.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationTemplate,
      DeviceToken,
      // I6 — incident push subscribers fan out incident.raised to all
      // active admin users.
      User,
      // order.created push subscriber queries active+online drivers
      // so dispatches reach everyone whose app is in background.
      DriverProfile,
      // order.created push subscriber joins wallets to gate recipients by
      // whether their balance covers the order's platform charge.
      Wallet,
    ]),
    RealtimeModule,
    // SystemConfigService — order.created push reads ORDER_DELIVERY_RADIUS_KM.
    SystemConfigModule,
  ],
  controllers: [
    NotificationsController,
    NotificationTemplateAdminController,
    DeviceTokensController,
  ],
  providers: [
    NotificationsService,
    NotificationTemplateService,
    PushNotificationService,
    SmsService,
    EmailService,
    PushFanoutService,
    PushFanoutEventSubscribers,
    DeviceTokensService,
  ],
  exports: [
    NotificationsService,
    NotificationTemplateService,
    PushFanoutService,
    // D4: InvitesService dispatches SMS via the shared sender.
    SmsService,
    // E4: ReceiptsService dispatches the receipt link via email + SMS.
    EmailService,
  ],
})
export class NotificationsModule {}
