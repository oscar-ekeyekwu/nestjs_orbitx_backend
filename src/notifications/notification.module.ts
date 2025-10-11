import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notification.service';
import { NotificationsController } from './notification.controller';
import { PushNotificationService } from './push-notification.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { Notification } from './entities/notification.entity';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [TypeOrmModule.forFeature([Notification]), RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    PushNotificationService,
    SmsService,
    EmailService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
