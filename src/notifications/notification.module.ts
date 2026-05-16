import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notification.service';
import { NotificationsController } from './notification.controller';
import { NotificationTemplateAdminController } from './notification-template.admin.controller';
import { NotificationTemplateService } from './notification-template.service';
import { PushNotificationService } from './push-notification.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { Notification } from './entities/notification.entity';
import { NotificationTemplate } from './entities/notification-template.entity';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, NotificationTemplate]),
    RealtimeModule,
  ],
  controllers: [NotificationsController, NotificationTemplateAdminController],
  providers: [
    NotificationsService,
    NotificationTemplateService,
    PushNotificationService,
    SmsService,
    EmailService,
  ],
  exports: [NotificationsService, NotificationTemplateService],
})
export class NotificationsModule {}
