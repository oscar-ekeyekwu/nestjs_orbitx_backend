import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SupportService } from './support.service';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { AdminCreateSupportTicketDto } from './dto/admin-create-support-ticket.dto';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { GetSupportTicketsQueryDto } from './dto/get-support-tickets-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

@ApiTags('Support')
@ApiBearerAuth()
@Controller('support/tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post()
  @ApiOperation({
    summary: 'File a new support ticket (any authenticated user)',
  })
  async create(@CurrentUser() user: User, @Body() dto: CreateSupportTicketDto) {
    return this.supportService.create(user.id, dto);
  }

  @Post('admin')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'File a ticket on behalf of a user (Admin only)' })
  async adminCreate(@Body() dto: AdminCreateSupportTicketDto) {
    const { userId, ...rest } = dto;
    return this.supportService.create(userId, rest);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List support tickets (Admin only)' })
  async findAll(@Query() query: GetSupportTicketsQueryDto) {
    return this.supportService.findAll(query);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get a support ticket (Admin only)' })
  async findOne(@Param('id') id: string) {
    return this.supportService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a support ticket (Admin only)' })
  async update(@Param('id') id: string, @Body() dto: UpdateSupportTicketDto) {
    return this.supportService.update(id, dto);
  }
}
