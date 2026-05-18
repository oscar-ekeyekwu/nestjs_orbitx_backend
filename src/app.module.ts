import { Module } from '@nestjs/common';
import {
  ConfigModule as NestConfigModule,
  ConfigService,
} from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrdersModule } from './orders/orders.module';
import { DriversModule } from './drivers/drivers.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationsModule } from './notifications/notification.module';
import { User } from './users/entities/user.entity';
import { Order } from './orders/entities/order.entity';
import { DriverProfile } from './drivers/entities/driver-profile.entity';
import { Notification } from './notifications/entities/notification.entity';
import { SystemConfig } from './config/entities/system-config.entity';
import { Wallet } from './wallet/entities/wallet.entity';
import { Transaction } from './wallet/entities/transaction.entity';
import { VirtualAccount } from './wallet/entities/virtual-account.entity';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { DatabaseModule } from './database/database.module';
import { SystemConfigModule } from './config/config.module';
import { WalletModule } from './wallet/wallet.module';
import { HealthModule } from './health/health.module';
import { UploadModule } from './upload/upload.module';
import { FaqsModule } from './faqs/faqs.module';
import { FAQ } from './faqs/entities/faq.entity';
import { PaymentModule } from './payment/payment.module';
import { AdminModule } from './admin/admin.module';
import { SupportModule } from './support/support.module';
import { SupportTicket } from './support/entities/support-ticket.entity';
import { NotificationTemplate } from './notifications/entities/notification-template.entity';
// ARCH-2 v1 entities — register here so TypeORM's metadata builder
// can resolve relations like DriverProfile.company before the
// feature modules that own them ship.
import { Company } from './companies/entities/company.entity';
import { CompanyMembership } from './companies/entities/company-membership.entity';
import { Vehicle } from './vehicles/entities/vehicle.entity';
import { VehicleAssignment } from './vehicles/entities/vehicle-assignment.entity';
import { Document } from './documents/entities/document.entity';
import { ApprovalDecision } from './approvals/entities/approval-decision.entity';
import { DeviceToken } from './notifications/entities/device-token.entity';
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRootAsync({
      imports: [NestConfigModule],
      // Allow tests + dev tools to bypass the rate limiter by setting
      //   THROTTLE_DISABLED=true
      // in the environment. In production this var is unset (or "false"),
      // so the configured limit applies. Per-route @Throttle() decorators
      // still apply on top of this when not disabled.
      useFactory: (config: ConfigService) => {
        const disabled = config.get<string>('THROTTLE_DISABLED') === 'true';
        return [
          {
            ttl: 60000, // 1 minute
            limit: disabled ? 1_000_000 : 100,
          },
        ];
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forRootAsync({
      imports: [NestConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST'),
        port: configService.get('DB_PORT'),
        username: configService.get('DB_USERNAME'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_NAME'),
        entities: [
          User,
          Order,
          DriverProfile,
          Notification,
          SystemConfig,
          Wallet,
          Transaction,
          VirtualAccount,
          RefreshToken,
          FAQ,
          SupportTicket,
          NotificationTemplate,
          // ARCH-2 v1 entities
          Company,
          CompanyMembership,
          Vehicle,
          VehicleAssignment,
          Document,
          ApprovalDecision,
          DeviceToken,
        ],
        synchronize: configService.get('NODE_ENV') === 'development',
        logging: configService.get('NODE_ENV') === 'development',
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    UsersModule,
    OrdersModule,
    DriversModule,
    RealtimeModule,
    NotificationsModule,
    DatabaseModule,
    SystemConfigModule,
    WalletModule,
    HealthModule,
    UploadModule,
    FaqsModule,
    PaymentModule,
    AdminModule,
    SupportModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
