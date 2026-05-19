import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InvitesService } from './invites.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('Invites')
@ApiBearerAuth()
@Controller('companies/:companyId/invites')
@UseGuards(JwtAuthGuard)
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  // Tight throttle on the mint endpoint — each call costs an SMS.
  // 10 per minute per IP discourages script-driven invite spam.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      'Mint a driver invite for the supplied phone. Only the company owner (or an admin) may invite, and only when the company is approved.',
  })
  create(
    @CurrentUser() user: User,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invitesService.createInvite(companyId, dto.phone, user);
  }

  @Get()
  @ApiOperation({
    summary:
      "List the company's outstanding + redeemed invites. Owner or admin only.",
  })
  list(
    @CurrentUser() user: User,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.invitesService.listForCompany(companyId, user);
  }
}
