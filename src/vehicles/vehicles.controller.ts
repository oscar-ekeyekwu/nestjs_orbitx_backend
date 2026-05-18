import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
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
import { VehiclesService, toVehicleResponse } from './vehicles.service';
import { VehicleStatus } from './entities/vehicle.entity';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleStatusDto } from './dto/update-vehicle-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Vehicles')
@ApiBearerAuth()
@Controller('vehicles')
@UseGuards(JwtAuthGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Register a new vehicle in draft status. Ownership is inferred from the caller`s driver_profile.accountType.',
  })
  async create(@CurrentUser() user: User, @Body() dto: CreateVehicleDto) {
    const vehicle = await this.vehiclesService.create(dto, user);
    return toVehicleResponse(vehicle);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List vehicles (admin only).' })
  @ApiQuery({ name: 'status', required: false, enum: VehicleStatus })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(
    @Query('status') status?: VehicleStatus,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    const result = await this.vehiclesService.findAll({
      status,
      limit,
      offset,
    });
    return {
      items: result.items.map(toVehicleResponse),
      total: result.total,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a single vehicle. Admins see any vehicle; other users see only ones their profile owns.',
  })
  async findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const vehicle = await this.vehiclesService.findByIdForUser(id, user);
    return toVehicleResponse(vehicle);
  }

  @Post(':id/submit-for-approval')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Driver / company-owner self-service: move a draft vehicle into the admin approval queue.',
  })
  async submit(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const vehicle = await this.vehiclesService.submitForApproval(id, user);
    return toVehicleResponse(vehicle);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Transition vehicle status (admin only). Sets approved_at / approved_by on approval; writes an approval_decisions audit row.',
  })
  async updateStatus(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleStatusDto,
  ) {
    const vehicle = await this.vehiclesService.transitionStatus(id, dto, user);
    return toVehicleResponse(vehicle);
  }
}
