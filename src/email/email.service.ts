import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { VerificationCode, VerificationType } from './entities/verification-code.entity';
import { IEmailDriver } from './interfaces/email-driver.interface';
import { SendGridDriver } from './drivers/sendgrid.driver';
import { SMTPDriver } from './drivers/smtp.driver';
import {
  getVerificationEmailTemplate,
  getPasswordResetTemplate,
} from './templates/verification-code.template';
import { ErrorCodes } from '../common/constants/error-codes';

export enum EmailDriver {
  SENDGRID = 'sendgrid',
  SMTP = 'smtp',
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private emailDriver: IEmailDriver;

  constructor(
    private configService: ConfigService,
    private sendGridDriver: SendGridDriver,
    private smtpDriver: SMTPDriver,
    @InjectRepository(VerificationCode)
    private verificationCodeRepository: Repository<VerificationCode>,
  ) {
    this.initializeDriver();
  }

  private initializeDriver() {
    const driver = this.configService.get<string>('EMAIL_DRIVER', 'smtp');

    switch (driver.toLowerCase()) {
      case EmailDriver.SENDGRID:
        this.emailDriver = this.sendGridDriver;
        this.logger.log('Using SendGrid email driver');
        break;
      case EmailDriver.SMTP:
      default:
        this.emailDriver = this.smtpDriver;
        this.logger.log('Using SMTP email driver');
        break;
    }
  }

  /**
   * Generate a 6-digit verification code
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(
    userId: string,
    email: string,
    type: VerificationType = VerificationType.EMAIL,
  ): Promise<void> {
    // Invalidate any existing unused codes for this user and type
    await this.verificationCodeRepository.update(
      {
        userId,
        type,
        isUsed: false,
      },
      {
        isUsed: true,
        usedAt: new Date(),
      },
    );

    // Generate new code
    const code = this.generateCode();
    const expiryMinutes = this.configService.get<number>('VERIFICATION_CODE_EXPIRY_MINUTES', 10);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Save verification code to database
    const verificationCode = this.verificationCodeRepository.create({
      userId,
      email,
      code,
      type,
      expiresAt,
    });

    await this.verificationCodeRepository.save(verificationCode);

    // Send email based on type
    let subject: string;
    let html: string;

    if (type === VerificationType.PASSWORD_RESET) {
      subject = 'Password Reset Code - OrbitX Dispatch';
      html = getPasswordResetTemplate(code, expiryMinutes);
    } else {
      subject = 'Email Verification Code - OrbitX Dispatch';
      html = getVerificationEmailTemplate(code, expiryMinutes);
    }

    await this.emailDriver.sendEmail({
      to: email,
      subject,
      html,
    });

    this.logger.log(`Verification email sent to ${email}`);
  }

  /**
   * Verify code
   */
  async verifyCode(
    userId: string,
    code: string,
    type: VerificationType = VerificationType.EMAIL,
  ): Promise<boolean> {
    const verificationCode = await this.verificationCodeRepository.findOne({
      where: {
        userId,
        code,
        type,
        isUsed: false,
      },
    });

    if (!verificationCode) {
      throw new BadRequestException({
        message: 'Invalid or expired verification code',
        errorCode: ErrorCodes.AUTH_011,
      });
    }

    // Check if code is expired
    if (new Date() > verificationCode.expiresAt) {
      throw new BadRequestException({
        message: 'Verification code has expired',
        errorCode: ErrorCodes.AUTH_012,
      });
    }

    // Check max attempts
    const maxAttempts = this.configService.get<number>('MAX_VERIFICATION_ATTEMPTS', 5);
    if (verificationCode.attempts >= maxAttempts) {
      throw new BadRequestException({
        message: 'Maximum verification attempts exceeded. Request a new code.',
        errorCode: ErrorCodes.AUTH_013,
      });
    }

    // Increment attempts
    verificationCode.attempts += 1;
    await this.verificationCodeRepository.save(verificationCode);

    // Mark as used
    verificationCode.isUsed = true;
    verificationCode.usedAt = new Date();
    await this.verificationCodeRepository.save(verificationCode);

    return true;
  }

  /**
   * Clean up expired verification codes (run as a cron job)
   */
  async cleanupExpiredCodes(): Promise<void> {
    const result = await this.verificationCodeRepository.delete({
      expiresAt: LessThan(new Date()),
      isUsed: true,
    });

    this.logger.log(`Cleaned up ${result.affected} expired verification codes`);
  }

  /**
   * Send custom email
   */
  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    await this.emailDriver.sendEmail({
      to,
      subject,
      html,
    });
  }
}
