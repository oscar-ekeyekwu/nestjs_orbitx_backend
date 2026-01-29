import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Req,
  Res,
  Ip,
  Headers,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { VerifyEmailDto } from '../email/dto/verify-email.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { ttl: 60000, limit: 3 } }) // 3 registrations per minute
  @ApiOperation({ summary: 'Register a new user' })
  async register(
    @Body() registerDto: RegisterDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60000, limit: 5 } }) // 5 login attempts per minute
  @ApiOperation({ summary: 'Login user' })
  async login(
    @Body() loginDto: LoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.login(loginDto);
  }

  @Post('refresh')
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // 10 refresh attempts per minute
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.refreshAccessToken(
      refreshTokenDto,
      ipAddress,
      userAgent,
    );
  }

  @Post('google')
  async googleAuth(@Body() googleAuthDto: GoogleAuthDto) {
    // In production, verify the Google token here
    // For now, we'll assume the token is valid and contains user info
    // You should use google-auth-library to verify the token

    // This is a simplified version - in production you'd decode and verify the token
    // const { token } = googleAuthDto;
    console.log(googleAuthDto);

    await Promise.resolve();

    // Mock user data - replace with actual token verification
    return {
      message: 'Google auth endpoint - implement token verification',
      // access_token: ...,
      // user: ...
    };
  }

  @Get('google/redirect')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(@Req() req, @Res() res: Response) {
    const { email, name, googleId, avatar } = req.user;

    // Default role for Google sign-in is customer
    // In production, you might want to ask the user to select their role
    const authResponse = await this.authService.googleAuth(
      email,
      name,
      googleId,
      avatar,
    );

    // Redirect to frontend with token
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8081';
    res.redirect(
      `${frontendUrl}/auth/callback?token=${authResponse.access_token}`,
    );
  }

  @Get('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser() user: User) {
    return this.authService.getProfile(user.id);
  }

  @Post('send-verification-email')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 3 } }) // 3 requests per minute
  @ApiOperation({ summary: 'Send email verification code' })
  async sendVerificationEmail(@CurrentUser() user: User) {
    await this.authService.sendVerificationEmail(user.id, user.email);
    return {
      message: 'Verification code sent to your email',
      email: user.email,
    };
  }

  @Post('verify-email')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } }) // 5 attempts per minute
  @ApiOperation({ summary: 'Verify email with code' })
  async verifyEmail(
    @CurrentUser() user: User,
    @Body() verifyEmailDto: VerifyEmailDto,
  ) {
    await this.authService.verifyEmail(user.id, verifyEmailDto.code);
    return {
      message: 'Email verified successfully',
      isEmailVerified: true,
    };
  }

  @Post('resend-verification-email')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 120000, limit: 2 } }) // 2 requests per 2 minutes
  @ApiOperation({ summary: 'Resend verification email' })
  async resendVerificationEmail(@CurrentUser() user: User) {
    await this.authService.sendVerificationEmail(user.id, user.email);
    return {
      message: 'Verification code resent to your email',
      email: user.email,
    };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  async logout(@Body() body: { refresh_token?: string }) {
    if (body.refresh_token) {
      await this.authService.revokeRefreshToken(body.refresh_token);
    }
    return { message: 'Logged out successfully' };
  }

  @Post('logout-all')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Logout from all devices' })
  async logoutAll(@CurrentUser() user: User) {
    await this.authService.revokeAllUserTokens(user.id);
    return { message: 'Logged out from all devices successfully' };
  }
}
