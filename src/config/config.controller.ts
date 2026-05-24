import {
  BadRequestException,
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
import {
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SystemConfigService } from './config.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { ConfigKey } from './enums/config-keys.enum';

interface SupportContactInfo {
  phone: string;
  email: string;
  whatsapp: string;
  hours: string;
}

const SUPPORT_INFO_DEFAULTS: SupportContactInfo = {
  phone: '',
  email: '',
  whatsapp: '',
  hours: '',
};

class UpdateSupportInfoDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  whatsapp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hours?: string;
}

class UpdateDriverSettingsDto {
  @IsOptional()
  @IsNumber()
  driverMinBalance?: number;

  @IsOptional()
  @IsNumber()
  orderDeliveryRadiusKm?: number;

  /**
   * G5 — platform commission percentage. The wallet split helper
   * additionally guards against out-of-range values at apply time, so
   * accidental persistence here still surfaces a clear runtime error.
   */
  @IsOptional()
  @IsNumber()
  driverCommissionPct?: number;
}

class UpdatePricingSettingsDto {
  @IsOptional()
  @IsNumber()
  baseFare?: number;

  @IsOptional()
  @IsNumber()
  perKmRate?: number;

  @IsOptional()
  @IsNumber()
  smallPackageMultiplier?: number;

  @IsOptional()
  @IsNumber()
  mediumPackageMultiplier?: number;

  @IsOptional()
  @IsNumber()
  largePackageMultiplier?: number;
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
    const [driverMinBalance, orderDeliveryRadiusKm, driverCommissionPct] =
      await Promise.all([
        this.configService.getNumber(ConfigKey.DRIVER_MIN_BALANCE, 5000),
        this.configService.getNumber(ConfigKey.ORDER_DELIVERY_RADIUS_KM, 50),
        this.configService.getNumber(
          ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
          15,
        ),
      ]);
    return { driverMinBalance, orderDeliveryRadiusKm, driverCommissionPct };
  }

  @Get('pricing-settings')
  @ApiOperation({
    summary: 'Get pricing settings used by the order pricing engine',
  })
  async getPricingSettings() {
    const [
      baseFare,
      perKmRate,
      smallPackageMultiplier,
      mediumPackageMultiplier,
      largePackageMultiplier,
    ] = await Promise.all([
      this.configService.getNumber(ConfigKey.ORDER_BASE_PRICE, 1000),
      this.configService.getNumber(ConfigKey.ORDER_PRICE_PER_KM, 100),
      this.configService.getNumber(ConfigKey.PACKAGE_SIZE_SMALL_MULTIPLIER, 1),
      this.configService.getNumber(
        ConfigKey.PACKAGE_SIZE_MEDIUM_MULTIPLIER,
        1.5,
      ),
      this.configService.getNumber(ConfigKey.PACKAGE_SIZE_LARGE_MULTIPLIER, 2),
    ]);
    return {
      baseFare,
      perKmRate,
      smallPackageMultiplier,
      mediumPackageMultiplier,
      largePackageMultiplier,
    };
  }

  @Put('pricing-settings')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update pricing settings (Admin only)' })
  async updatePricingSettings(@Body() dto: UpdatePricingSettingsDto) {
    const fieldToKey: Array<[keyof UpdatePricingSettingsDto, ConfigKey]> = [
      ['baseFare', ConfigKey.ORDER_BASE_PRICE],
      ['perKmRate', ConfigKey.ORDER_PRICE_PER_KM],
      ['smallPackageMultiplier', ConfigKey.PACKAGE_SIZE_SMALL_MULTIPLIER],
      ['mediumPackageMultiplier', ConfigKey.PACKAGE_SIZE_MEDIUM_MULTIPLIER],
      ['largePackageMultiplier', ConfigKey.PACKAGE_SIZE_LARGE_MULTIPLIER],
    ];

    const updates = fieldToKey
      .filter(([field]) => dto[field] !== undefined)
      .map(([field, key]) =>
        this.configService.update(key, {
          key,
          value: String(dto[field]),
          dataType: 'number',
        }),
      );

    await Promise.all(updates);
    return this.getPricingSettings();
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

    if (dto.driverCommissionPct !== undefined) {
      if (dto.driverCommissionPct < 0 || dto.driverCommissionPct > 100) {
        throw new BadRequestException(
          'driverCommissionPct must be between 0 and 100.',
        );
      }
      updates.push(
        this.configService.update(ConfigKey.DRIVER_COMMISSION_PERCENTAGE, {
          key: ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
          value: String(dto.driverCommissionPct),
          dataType: 'number',
        }),
      );
    }

    await Promise.all(updates);

    const [driverMinBalance, orderDeliveryRadiusKm, driverCommissionPct] =
      await Promise.all([
        this.configService.getNumber(ConfigKey.DRIVER_MIN_BALANCE, 5000),
        this.configService.getNumber(ConfigKey.ORDER_DELIVERY_RADIUS_KM, 50),
        this.configService.getNumber(
          ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
          15,
        ),
      ]);

    return { driverMinBalance, orderDeliveryRadiusKm, driverCommissionPct };
  }

  @Get('support-info')
  @ApiOperation({
    summary:
      'Get public support contact info shown in the mobile apps. Any authenticated user can read; only Admins can update.',
  })
  async getSupportInfo(): Promise<SupportContactInfo> {
    const stored = await this.configService.get<Partial<SupportContactInfo>>(
      ConfigKey.SUPPORT_CONTACT_INFO,
      SUPPORT_INFO_DEFAULTS,
    );
    // Defensive merge: a partial value (e.g. from a hand-edited row that
    // dropped a field) still resolves to a complete shape for callers.
    return { ...SUPPORT_INFO_DEFAULTS, ...(stored ?? {}) };
  }

  @Put('support-info')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update support contact info (Admin only)' })
  async updateSupportInfo(
    @Body() dto: UpdateSupportInfoDto,
  ): Promise<SupportContactInfo> {
    const current = await this.getSupportInfo();
    const next: SupportContactInfo = {
      phone: dto.phone ?? current.phone,
      email: dto.email ?? current.email,
      whatsapp: dto.whatsapp ?? current.whatsapp,
      hours: dto.hours ?? current.hours,
    };
    await this.configService.update(ConfigKey.SUPPORT_CONTACT_INFO, {
      key: ConfigKey.SUPPORT_CONTACT_INFO,
      value: JSON.stringify(next),
      dataType: 'json',
    });
    return next;
  }

  @Get(':key')
  @ApiOperation({ summary: 'Get a specific configuration by key' })
  async getByKey(@Param('key') key: string): Promise<{ value: unknown }> {
    const value = await this.configService.get(key);
    return { value };
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
