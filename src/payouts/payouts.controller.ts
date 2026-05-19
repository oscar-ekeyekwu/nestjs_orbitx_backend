import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { PayoutsService } from './payouts.service';

class MarkManualCompleteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  receiptReference!: string;
}

/**
 * G4 — admin disbursement console.
 *
 * GET  /admin/payouts                — manual queue (pending_manual)
 * POST /admin/payouts/:id/mark-paid  — admin confirms a manual disbursement
 * GET  /admin/payouts/:id/statement  — placeholder (PDF deferred per AC)
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/payouts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class PayoutsAdminController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List pending manual payouts (pending_manual) oldest first for the disbursement queue.',
  })
  listManual(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.payouts.listManualPending({ limit, offset });
  }

  @Post(':id/mark-paid')
  @ApiOperation({
    summary:
      'Admin marks a manual payout disbursed with a bank receipt reference. Idempotent.',
  })
  markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkManualCompleteDto,
    @CurrentUser() admin: User,
  ) {
    return this.payouts.markManualComplete(id, dto, admin);
  }

  @Get(':id/statement')
  @ApiOperation({
    summary:
      'Payout statement download. Deferred per G4 — returns a placeholder.',
  })
  statement(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.getStatementPlaceholder(id);
  }
}
