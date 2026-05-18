import { Module } from '@nestjs/common';
import {
  ConfigModule as NestConfigModule,
  ConfigService,
} from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrdersModule } from './orders/orders.module';
import { DriversModule } from './drivers/drivers.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationsModule } from './notifications/notification.module';
import { DatabaseModule } from './database/database.module';
import { SystemConfigModule } from './config/config.module';
import { WalletModule } from './wallet/wallet.module';
import { HealthModule } from './health/health.module';
import { UploadModule } from './upload/upload.module';
import { FaqsModule } from './faqs/faqs.module';
import { PaymentModule } from './payment/payment.module';
import { AdminModule } from './admin/admin.module';
import { SupportModule } from './support/support.module';
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
    // TypeORM is wired in DatabaseModule (imported below) with a glob
    // entity discovery — single source of truth. Do NOT add a second
    // TypeOrmModule.forRootAsync here; the explicit entity list that
    // used to live in this block silently drifted from reality every
    // time a new entity shipped (ARCH-2 hit this exactly: container
    // boot died with "Entity metadata for DriverProfile#company was
    // not found" because Company was never added back).
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
