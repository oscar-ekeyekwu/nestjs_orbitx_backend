import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

export interface GoogleUser {
  email: string;
  name: string;
  avatar?: string;
  googleId: string;
  accessToken: string;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly configService: ConfigService) {
    super({
      clientID: configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: configService.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
    });
  }

  /**
   * Validate Google OAuth response and return normalized user data
   */
  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const email = profile.emails?.[0]?.value;
    const avatar = profile.photos?.[0]?.value;
    const givenName = profile.name?.givenName ?? '';
    const familyName = profile.name?.familyName ?? '';

    if (!email) {
      done(new Error('Google account has no public email.'));
      return;
    }

    const user: GoogleUser = {
      email,
      name: `${givenName} ${familyName}`.trim(),
      avatar,
      googleId: profile.id,
      accessToken,
    };

    await Promise.resolve();
    done(null, user);
  }
}
