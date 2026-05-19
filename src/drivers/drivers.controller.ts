import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DriversService } from './drivers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { UpdateDriverVerificationDto } from './dto/update-driver-verification.dto';

@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DRIVER)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  // C5 — admin queue listing. Placed BEFORE @Get('profile') because the
  // route literal `admin/pending` would otherwise be shadowed by Nest's
  // sibling-route resolution if a parameter came first.
  @Get('admin/pending')
  @Roles(UserRole.ADMIN)
  listPendingForAdmin(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.driversService.findPendingForAdmin({ limit, offset });
  }

  // C5 — admin patches verification status. Body is { status, reason? }.
  @Patch(':id/verification')
  @Roles(UserRole.ADMIN)
  transitionVerification(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverVerificationDto,
  ) {
    return this.driversService.transitionVerification(id, dto, user);
  }

  // D2 — driver self-submits their setup for admin review.
  // Resolves the calling user → driver_profile → setup_required →
  // pending_approval via DriversService.submitForApproval. NULL
  // reviewerId on the audit row (system sentinel).
  @Post('profile/submit')
  async submitProfileForApproval(@CurrentUser() user: User) {
    const profile = await this.driversService.findByUserId(user.id);
    if (!profile) {
      // Auto-create + immediately submit, mirroring updateOnlineStatus's
      // backfill path. A driver registering through Auth always lands
      // with a profile, so this only fires for pre-A3 legacy users.
      const created = await this.driversService.createProfile(user.id);
      return this.driversService.submitForApproval(created.id);
    }
    return this.driversService.submitForApproval(profile.id);
  }

  @Get('profile')
  getProfile(@CurrentUser() user: User) {
    return this.driversService.findByUserId(user.id);
  }

  @Get('stats')
  getStats(@CurrentUser() user: User) {
    return this.driversService.getStats(user.id);
  }

  @Post('online')
  toggleOnline(@CurrentUser() user: User, @Body('isOnline') isOnline: boolean) {
    return this.driversService.updateOnlineStatus(user.id, isOnline);
  }

  @Patch('location')
  updateLocation(
    @CurrentUser() user: User,
    @Body('latitude') latitude: number,
    @Body('longitude') longitude: number,
  ) {
    return this.driversService.updateLocation(user.id, latitude, longitude);
  }
}
