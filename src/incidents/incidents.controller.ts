import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/entities/user.entity';
import { CloseIncidentDto } from './dto/close-incident.dto';
import { RaiseSosDto } from './dto/raise-sos.dto';
import { IncidentStatus } from './entities/incident.entity';
import { IncidentsService } from './incidents.service';

/**
 * I6 — SOS endpoints.
 *   POST /sos                       (driver only) — raise an incident
 *   GET  /incidents                 (admin only)  — list (optional status filter)
 *   GET  /incidents/:id             (admin only)
 *   POST /incidents/:id/acknowledge (admin only)
 *   POST /incidents/:id/close       (admin only)
 */
@ApiTags('Incidents')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class IncidentsController {
  constructor(private readonly service: IncidentsService) {}

  @Post('sos')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      'Driver raises an SOS during an active delivery. Auto-notifies on-duty admins.',
  })
  async raise(@CurrentUser() user: User, @Body() dto: RaiseSosDto) {
    return this.service.raise(dto, user.id);
  }

  @Get('incidents')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List recent incidents (admin only).' })
  async list(@Query('status') status?: IncidentStatus) {
    return this.service.list(status ? { status } : undefined);
  }

  @Get('incidents/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Fetch a single incident (admin only).' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post('incidents/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Acknowledge an incident. Records time-to-ack metric + emits incident.acknowledged for driver push.',
  })
  async acknowledge(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.acknowledge(id, user.id);
  }

  @Post('incidents/:id/close')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Close an incident with outcome + note. Clears orders.incidentFlagged when no other open incidents remain on that order.',
  })
  async close(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseIncidentDto,
  ) {
    return this.service.close(id, dto, user.id);
  }
}
