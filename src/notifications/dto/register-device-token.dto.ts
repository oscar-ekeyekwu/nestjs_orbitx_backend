import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { DevicePlatform } from '../entities/device-token.entity';

/**
 * J1 — body for `POST /device-tokens`. The token shape is opaque to
 * the backend; the fanout service just hands it back to FCM / APNs.
 * Cap length at 4096 so we can't be flooded with multi-MB payloads.
 */
export class RegisterDeviceTokenDto {
  @ApiProperty({
    example: 'ExponentPushToken[abcdef...]',
    description:
      'Opaque push token from Expo Notifications / FCM / APNs. Stored and replayed against the push provider on send.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;
}
