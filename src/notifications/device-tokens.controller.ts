import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { DeviceTokensService } from './device-tokens.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';

/**
 * J1 — caller-scoped device-token CRUD. Auth-gated so the userId on
 * each row matches the calling identity; the mobile client posts on
 * first login (or app cold-start after permission grant), and DELETEs
 * on logout.
 */
@ApiTags('Device Tokens')
@ApiBearerAuth()
@Controller('device-tokens')
@UseGuards(JwtAuthGuard)
export class DeviceTokensController {
  constructor(private readonly service: DeviceTokensService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Register the calling user`s push token. Idempotent: re-posting the same token bumps updatedAt and reactivates a previously-revoked row.',
  })
  async register(
    @CurrentUser() user: User,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    const row = await this.service.register(user.id, dto.token, dto.platform);
    // Don't echo the token back — caller already has it.
    return {
      id: row.id,
      platform: row.platform,
      isActive: row.isActive,
      updatedAt: row.updatedAt,
    };
  }

  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Revoke a push token (typically on logout). Soft-flips `isActive=false`; PushFanoutService skips inactive rows.',
  })
  async remove(@CurrentUser() user: User, @Param('token') token: string) {
    await this.service.remove(user.id, token);
  }
}
