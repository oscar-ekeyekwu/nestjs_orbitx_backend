import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { UsersModule } from '../users/users.module';
import { DriversModule } from '../drivers/drivers.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RefreshToken } from './entities/refresh-token.entity';
import { EmailModule } from '../email/email.module';
import { InvitesModule } from '../invites/invites.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshToken]),
    UsersModule,
    // DriversModule is imported so AuthService can create a DriverProfile in
    // the same transaction as the User when a driver registers (story A3).
    DriversModule,
    EmailModule,
    // D4 — InvitesService.redeemInTransaction is called from
    // AuthService.register when an inviteToken is present.
    InvitesModule,
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),

    // Import JwtModule so JwtService can be injected
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') as string,
        signOptions: {
          expiresIn: configService.get<number>('JWT_EXPIRES_IN') as number,
        },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
