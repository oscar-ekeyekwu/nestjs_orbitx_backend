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
  NotImplementedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { VerifyEmailDto } from '../email/dto/verify-email.dto';

interface GoogleAuthRequest extends Request {
  user: {
    email: string;
    name: string;
    googleId: string;
    avatar: string;
  };
}

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
    return this.authService.register(registerDto, ipAddress, userAgent);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60000, limit: 5 } }) // 5 login attempts per minute
  @ApiOperation({ summary: 'Login user' })
  async login(
    @Body() loginDto: LoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.login(loginDto, ipAddress, userAgent);
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
  @ApiOperation({
    summary:
      'Google OAuth login (NOT IMPLEMENTED — returns 501 until token verification is wired)',
  })
  googleAuth() {
    // Intentionally fail loudly until the real implementation lands:
    //   1. Install `google-auth-library`
    //   2. Verify the Google id_token against GOOGLE_CLIENT_ID
    //   3. Extract { email, name, googleId, avatar } from the verified payload
    //   4. Call this.authService.googleAuth(...) (the service already exists)
    // The mobile app currently hides its Google Sign-In button to match.
    throw new NotImplementedException(
      'Google sign-in is not enabled on this server. Use email + password.',
    );
  }

  @Get('google/redirect')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(
    @Req() req: GoogleAuthRequest,
    @Res() res: Response,
  ) {
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
