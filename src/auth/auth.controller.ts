import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('google')
  async googleAuth(@Body() googleAuthDto: GoogleAuthDto) {
    // In production, verify the Google token here
    // For now, we'll assume the token is valid and contains user info
    // You should use google-auth-library to verify the token

    // This is a simplified version - in production you'd decode and verify the token
    const { token, role } = googleAuthDto;

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
  @UseGuards(JwtAuthGuard)
  async getProfile(@CurrentUser() user: User) {
    return this.authService.getProfile(user.id);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout() {
    // In a stateless JWT setup, logout is handled client-side
    // If you want to implement token blacklisting, do it here
    return { message: 'Logged out successfully' };
  }
}
