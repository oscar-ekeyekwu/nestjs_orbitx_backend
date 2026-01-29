import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { JwtPayload } from '../common/interfaces/jwt-payload.interface';
import { UserRole } from '../common/enums/user-role.enum';
import { instanceToPlain } from 'class-transformer';
import * as crypto from 'crypto';
import { EmailService } from '../email/email.service';
import { VerificationType } from '../email/entities/verification-code.entity';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
  ) {}

  async register(registerDto: RegisterDto) {
    const user = await this.usersService.create(registerDto);
    return this.generateAuthResponse(user);
  }

  async login(loginDto: LoginDto) {
    const user = await this.validateUser(loginDto.email, loginDto.password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.generateAuthResponse(user);
  }

  async googleAuth(
    email: string,
    name: string,
    googleId: string,
    avatar: string,
    role: UserRole = UserRole.CUSTOMER,
  ) {
    const user = await this.usersService.createOrUpdateGoogleUser(
      email,
      name,
      googleId,
      avatar,
      role,
    );

    return this.generateAuthResponse(user);
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      return null;
    }

    const isPasswordValid = await user.validatePassword(password);

    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  private async generateAuthResponse(
    user: User,
    deviceId?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    // Use class-transformer to properly exclude password field
    const userWithoutPassword = instanceToPlain(user) as Omit<User, 'password'>;

    const accessToken = this.jwtService.sign(payload);
    const decoded = this.jwtService.decode(accessToken) as { exp?: number };

    // Generate refresh token
    const refreshToken = await this.createRefreshToken(
      user.id,
      deviceId,
      ipAddress,
      userAgent,
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken.token,
      expires_at: decoded?.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : null,
      user: userWithoutPassword,
    };
  }

  /**
   * Create a new refresh token
   */
  private async createRefreshToken(
    userId: string,
    deviceId?: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<RefreshToken> {
    // Generate a secure random token
    const token = crypto.randomBytes(64).toString('hex');

    // Get refresh token expiry from config (default 30 days)
    const refreshTokenExpiryDays = this.configService.get<number>(
      'JWT_REFRESH_EXPIRES_DAYS',
      30,
    );
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshTokenExpiryDays);

    // Revoke old refresh tokens for this device (if deviceId provided)
    if (deviceId) {
      await this.refreshTokenRepository.update(
        { userId, deviceId, isRevoked: false },
        { isRevoked: true },
      );
    }

    const refreshToken = this.refreshTokenRepository.create({
      userId,
      token,
      expiresAt,
      deviceId,
      ipAddress,
      userAgent,
    });

    return this.refreshTokenRepository.save(refreshToken);
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(
    refreshTokenDto: RefreshTokenDto,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token: refreshTokenDto.refresh_token },
      relations: ['user'],
    });

    if (!refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (refreshToken.isRevoked) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (new Date() > refreshToken.expiresAt) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    if (!refreshToken.user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    // Generate new auth response with new tokens
    return this.generateAuthResponse(
      refreshToken.user,
      refreshTokenDto.deviceId || refreshToken.deviceId,
      ipAddress,
      userAgent,
    );
  }

  /**
   * Revoke refresh token (logout)
   */
  async revokeRefreshToken(token: string): Promise<void> {
    await this.refreshTokenRepository.update({ token }, { isRevoked: true });
  }

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
  }

  /**
   * Clean up expired refresh tokens
   */
  async cleanupExpiredTokens(): Promise<void> {
    await this.refreshTokenRepository
      .createQueryBuilder()
      .delete()
      .where('expiresAt < :now', { now: new Date() })
      .execute();
  }

  /**
   * Send email verification code
   */
  async sendVerificationEmail(userId: string, email: string): Promise<void> {
    await this.emailService.sendVerificationEmail(
      userId,
      email,
      VerificationType.EMAIL,
    );
  }

  /**
   * Verify email with code
   */
  async verifyEmail(userId: string, code: string): Promise<void> {
    // Verify the code
    await this.emailService.verifyCode(userId, code, VerificationType.EMAIL);

    // Update user's email verification status
    await this.usersService.updateEmailVerificationStatus(userId, true);
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Use class-transformer to properly exclude password field
    return instanceToPlain(user) as Omit<User, 'password'>;
  }
}
