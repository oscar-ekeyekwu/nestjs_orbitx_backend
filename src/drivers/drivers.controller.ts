import { Controller, Get, Post, Body, Patch, UseGuards } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';

@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DRIVER)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

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
