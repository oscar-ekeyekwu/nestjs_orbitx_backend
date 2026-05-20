import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { MeService } from './me.service';

/**
 * I1 — NDPA data-subject-rights endpoints. All routes are scoped to
 * the authenticated user.
 *   GET    /me/export   → JSON snapshot of first-party data.
 *   POST   /me/delete   → schedule deletion (30-day grace).
 *   DELETE /me/delete   → cancel a pending deletion request.
 *   POST   /me/consent  → record explicit policy consent.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly service: MeService) {}

  @Get('export')
  @ApiOperation({
    summary:
      'NDPA §31 — return a JSON snapshot of the caller`s first-party data.',
  })
  async export(@CurrentUser() user: User) {
    return this.service.export(user.id);
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'NDPA §34 — schedule the caller`s account for pseudonymisation after a 30-day grace window. Idempotent.',
  })
  async requestDelete(@CurrentUser() user: User) {
    const updated = await this.service.requestDelete(user.id);
    return {
      deletionScheduledAt: updated.deletionScheduledAt,
      executesAt: updated.deletionScheduledAt
        ? new Date(
            updated.deletionScheduledAt.getTime() + 30 * 24 * 60 * 60 * 1000,
          )
        : null,
    };
  }

  @Delete('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a pending deletion request. Only valid within the 30-day grace window.',
  })
  async cancelDelete(@CurrentUser() user: User) {
    const updated = await this.service.cancelDeletion(user.id);
    return {
      deletionScheduledAt: updated.deletionScheduledAt,
    };
  }

  @Post('consent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'NDPA §32 / DR-N5 — record explicit acceptance of the privacy policy. Stamps users.consentedAt.',
  })
  async consent(@CurrentUser() user: User) {
    const updated = await this.service.consent(user.id);
    return { consentedAt: updated.consentedAt };
  }
}
