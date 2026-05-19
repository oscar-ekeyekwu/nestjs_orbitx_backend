import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';

/**
 * G3 / H8 — admin reconcile queue for manual bank transfers.
 *
 * GET  /admin/transfers                       — paginated pending list
 * POST /admin/transfers/:reference/reconcile  — mark a deposit received
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/transfers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminTransfersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: 'List orders with paymentStatus=pending_transfer (oldest first).',
  })
  list(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.ordersService.listPendingTransfers({ limit, offset });
  }

  @Post(':reference/reconcile')
  @ApiOperation({
    summary:
      'Mark a bank-transfer order as received. Inserts a transactions row + approval_decisions audit. Idempotent.',
  })
  reconcile(@Param('reference') reference: string, @CurrentUser() admin: User) {
    return this.ordersService.reconcileBankTransfer(reference, admin);
  }
}
