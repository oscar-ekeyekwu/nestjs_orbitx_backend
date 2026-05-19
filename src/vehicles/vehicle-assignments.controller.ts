import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { VehicleAssignmentsService } from './vehicle-assignments.service';
import { CreateVehicleAssignmentDto } from './dto/create-vehicle-assignment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('VehicleAssignments')
@ApiBearerAuth()
@Controller('vehicle-assignments')
@UseGuards(JwtAuthGuard)
export class VehicleAssignmentsController {
  constructor(private readonly assignmentsService: VehicleAssignmentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Assign a driver to a vehicle. Owner-or-admin only; driver must be an approved member of the owning company.',
  })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateVehicleAssignmentDto,
  ) {
    return this.assignmentsService.assign(dto, user);
  }

  @Get()
  @ApiOperation({
    summary:
      'List vehicle assignments. Admins see all; owners see their own company`s.',
  })
  @ApiQuery({ name: 'vehicleId', required: false, type: String })
  @ApiQuery({ name: 'driverId', required: false, type: String })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  async list(
    @CurrentUser() user: User,
    @Query('vehicleId') vehicleId?: string,
    @Query('driverId') driverId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.assignmentsService.findAll({
      caller: user,
      vehicleId,
      driverId,
      activeOnly: activeOnly === 'true',
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Soft-unassign a driver from a vehicle. The row stays for audit; unassigned_at = now().',
  })
  async unassign(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assignmentsService.unassign(id, user);
  }
}
