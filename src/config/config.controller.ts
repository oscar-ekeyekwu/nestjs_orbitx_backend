import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';
import { SystemConfigService } from './config.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { ConfigKey } from './enums/config-keys.enum';

class UpdateDriverSettingsDto {
  @IsOptional()
  @IsNumber()
  driverMinBalance?: number;

  @IsOptional()
  @IsNumber()
  orderDeliveryRadiusKm?: number;
}

@ApiTags('Configuration')
@ApiBearerAuth()
@Controller('config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConfigController {
  constructor(private readonly configService: SystemConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Get all system configurations' })
  async getAll() {
    return this.configService.getAll();
  }

  // Specific routes must come before parameterized :key routes
  @Get('driver-settings')
  @ApiOperation({ summary: 'Get driver and order settings' })
  async getDriverSettings() {
    const [driverMinBalance, orderDeliveryRadiusKm] = await Promise.all([
      this.configService.getNumber(ConfigKey.DRIVER_MIN_BALANCE, 5000),
      this.configService.getNumber(ConfigKey.ORDER_DELIVERY_RADIUS_KM, 50),
    ]);
    return { driverMinBalance, orderDeliveryRadiusKm };
  }

  @Put('driver-settings')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update driver and order settings (Admin only)' })
  async updateDriverSettings(@Body() dto: UpdateDriverSettingsDto) {
    const updates: Promise<any>[] = [];

    if (dto.driverMinBalance !== undefined) {
      updates.push(
        this.configService.update(ConfigKey.DRIVER_MIN_BALANCE, {
          key: ConfigKey.DRIVER_MIN_BALANCE,
          value: String(dto.driverMinBalance),
          dataType: 'number',
        }),
      );
    }

    if (dto.orderDeliveryRadiusKm !== undefined) {
      updates.push(
        this.configService.update(ConfigKey.ORDER_DELIVERY_RADIUS_KM, {
          key: ConfigKey.ORDER_DELIVERY_RADIUS_KM,
          value: String(dto.orderDeliveryRadiusKm),
          dataType: 'number',
        }),
      );
    }

    await Promise.all(updates);

    const [driverMinBalance, orderDeliveryRadiusKm] = await Promise.all([
      this.configService.getNumber(ConfigKey.DRIVER_MIN_BALANCE, 5000),
      this.configService.getNumber(ConfigKey.ORDER_DELIVERY_RADIUS_KM, 50),
    ]);

    return { driverMinBalance, orderDeliveryRadiusKm };
  }

  @Get(':key')
  @ApiOperation({ summary: 'Get a specific configuration by key' })
  async getByKey(@Param('key') key: string) {
    return this.configService.get(key);
  }

  @Put(':key')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a configuration (Admin only)' })
  async update(@Param('key') key: string, @Body() updateDto: UpdateConfigDto) {
    return this.configService.update(key, { ...updateDto, key });
  }

  @Put()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Bulk update configurations (Admin only)' })
  async bulkUpdate(@Body() updates: UpdateConfigDto[]) {
    return this.configService.bulkUpdate(updates);
  }

  @Delete(':key')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a configuration (Admin only)' })
  async delete(@Param('key') key: string) {
    await this.configService.delete(key);
  }
}
