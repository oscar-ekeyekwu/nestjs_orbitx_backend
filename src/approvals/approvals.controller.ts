import {
  Controller,
  Get,
  ParseIntPipe,
  ParseUUIDPipe,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApprovalsService } from './approvals.service';
import { ListApprovalDecisionsDto } from './dto/list-approval-decisions.dto';
import { ApprovalTargetType } from './entities/approval-decision.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('approval-decisions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List approval-decision rows (admin only). Filter by targetType, targetId, reviewerId, or action.',
  })
  list(
    @Query() filters: ListApprovalDecisionsDto,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    return this.approvalsService.list(filters, { limit, offset });
  }

  @Get(':targetType/:targetId')
  @ApiOperation({
    summary:
      'Full decision history for a single target. Useful for the admin-detail panels.',
  })
  findByTarget(
    @Param('targetType') targetType: ApprovalTargetType,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.approvalsService.findByTarget(targetType, targetId);
  }
}
