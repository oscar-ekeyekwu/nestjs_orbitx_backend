import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';
import { SendGridDriver } from './drivers/sendgrid.driver';
import { SMTPDriver } from './drivers/smtp.driver';
import { VerificationCode } from './entities/verification-code.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationCode]),
    ConfigModule,
  ],
  providers: [EmailService, SendGridDriver, SMTPDriver],
  exports: [EmailService],
})
export class EmailModule {}
