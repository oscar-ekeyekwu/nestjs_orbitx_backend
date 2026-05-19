import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { VehiclePendingUpdatesService } from './vehicle-pending-updates.service';

export class ReviewPendingUpdateDto {
  @ApiProperty({
    enum: ['approve', 'reject'],
    description:
      'F2 — approve applies the proposed values to the live vehicle row; reject leaves it untouched. Both write an approval_decisions audit entry.',
  })
  @IsEnum(['approve', 'reject'])
  action: 'approve' | 'reject';

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * F2 — admin endpoints for the pending-update queue. The same C5
 * surface ultimately groups these alongside driver / company / document
 * approvals, but the dedicated route is exposed here so cron / automation
 * scripts can hit it directly.
 */
@ApiTags('Vehicles')
@ApiBearerAuth()
@Controller('vehicle-pending-updates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class VehiclePendingUpdatesController {
  constructor(private readonly pendingUpdates: VehiclePendingUpdatesService) {}

  @Get()
  @ApiOperation({
    summary: 'List pending vehicle edits awaiting admin review (oldest first).',
  })
  list(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.pendingUpdates.listPending({ limit, offset });
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Approve or reject a pending vehicle edit. Approve applies the proposed values to the live row.',
  })
  async review(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewPendingUpdateDto,
  ) {
    if (dto.action === 'approve') {
      return this.pendingUpdates.approve(id, admin, dto.reason);
    }
    return this.pendingUpdates.reject(id, admin, dto.reason ?? '');
  }
}
