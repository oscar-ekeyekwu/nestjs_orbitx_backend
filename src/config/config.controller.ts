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
  IsIn,
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

  /**
   * Per-order platform charge knobs. Mode selects which inputs apply:
   * 'flat' → driverChargeFlat; 'percentage' → driverChargePercentage
   * capped by driverChargeCap.
   */
  @IsOptional()
  @IsIn(['flat', 'percentage'])
  driverChargeMode?: 'flat' | 'percentage';

  @IsOptional()
  @IsNumber()
  driverChargeFlat?: number;

  @IsOptional()
  @IsNumber()
  driverChargePercentage?: number;

  @IsOptional()
  @IsNumber()
  driverChargeCap?: number;
}

class UpdateMapsSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;
}

class UpdateAllowedIdTypesDto {
  @IsString({ each: true })
  allowed!: string[];
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

  /**
   * Insurance fee debited to the rider per completed delivery. Two
   * knobs; percent takes precedence when > 0, otherwise fixed
   * applies. Both 0 = insurance disabled (default).
   */
  @IsOptional()
  @IsNumber()
  insuranceFeeFixed?: number;

  @IsOptional()
  @IsNumber()
  insuranceFeePercent?: number;
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
    const [
      driverMinBalance,
      orderDeliveryRadiusKm,
      driverCommissionPct,
      driverChargeMode,
      driverChargeFlat,
      driverChargePercentage,
      driverChargeCap,
    ] = await Promise.all([
      this.configService.getNumber(ConfigKey.DRIVER_MIN_BALANCE, 5000),
      this.configService.getNumber(ConfigKey.ORDER_DELIVERY_RADIUS_KM, 50),
      this.configService.getNumber(ConfigKey.DRIVER_COMMISSION_PERCENTAGE, 15),
      this.configService.getString(ConfigKey.DRIVER_CHARGE_MODE, 'flat'),
      this.configService.getNumber(ConfigKey.DRIVER_CHARGE_FLAT, 200),
      this.configService.getNumber(ConfigKey.DRIVER_CHARGE_PERCENTAGE, 10),
      this.configService.getNumber(ConfigKey.DRIVER_CHARGE_CAP, 0),
    ]);
    return {
      driverMinBalance,
      orderDeliveryRadiusKm,
      driverCommissionPct,
      driverChargeMode,
      driverChargeFlat,
      driverChargePercentage,
      driverChargeCap,
    };
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
      insuranceFeeFixed,
      insuranceFeePercent,
    ] = await Promise.all([
      this.configService.getNumber(ConfigKey.ORDER_BASE_PRICE, 1000),
      this.configService.getNumber(ConfigKey.ORDER_PRICE_PER_KM, 100),
      this.configService.getNumber(ConfigKey.PACKAGE_SIZE_SMALL_MULTIPLIER, 1),
      this.configService.getNumber(
        ConfigKey.PACKAGE_SIZE_MEDIUM_MULTIPLIER,
        1.5,
      ),
      this.configService.getNumber(ConfigKey.PACKAGE_SIZE_LARGE_MULTIPLIER, 2),
      this.configService.getNumber(ConfigKey.ORDER_INSURANCE_FEE_FIXED, 0),
      this.configService.getNumber(ConfigKey.ORDER_INSURANCE_FEE_PERCENT, 0),
    ]);
    return {
      baseFare,
      perKmRate,
      smallPackageMultiplier,
      mediumPackageMultiplier,
      largePackageMultiplier,
      insuranceFeeFixed,
      insuranceFeePercent,
    };
  }

  @Put('pricing-settings')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update pricing settings (Admin only)' })
  async updatePricingSettings(@Body() dto: UpdatePricingSettingsDto) {
    if (
      dto.insuranceFeePercent !== undefined &&
      (dto.insuranceFeePercent < 0 || dto.insuranceFeePercent > 100)
    ) {
      throw new BadRequestException(
        'insuranceFeePercent must be between 0 and 100.',
      );
    }
    if (dto.insuranceFeeFixed !== undefined && dto.insuranceFeeFixed < 0) {
      throw new BadRequestException('insuranceFeeFixed must be 0 or greater.');
    }

    const fieldToKey: Array<[keyof UpdatePricingSettingsDto, ConfigKey]> = [
      ['baseFare', ConfigKey.ORDER_BASE_PRICE],
      ['perKmRate', ConfigKey.ORDER_PRICE_PER_KM],
      ['smallPackageMultiplier', ConfigKey.PACKAGE_SIZE_SMALL_MULTIPLIER],
      ['mediumPackageMultiplier', ConfigKey.PACKAGE_SIZE_MEDIUM_MULTIPLIER],
      ['largePackageMultiplier', ConfigKey.PACKAGE_SIZE_LARGE_MULTIPLIER],
      ['insuranceFeeFixed', ConfigKey.ORDER_INSURANCE_FEE_FIXED],
      ['insuranceFeePercent', ConfigKey.ORDER_INSURANCE_FEE_PERCENT],
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

    if (dto.driverChargeMode !== undefined) {
      updates.push(
        this.configService.update(ConfigKey.DRIVER_CHARGE_MODE, {
          key: ConfigKey.DRIVER_CHARGE_MODE,
          value: dto.driverChargeMode,
          dataType: 'string',
        }),
      );
    }

    if (dto.driverChargeFlat !== undefined) {
      if (dto.driverChargeFlat < 0) {
        throw new BadRequestException('driverChargeFlat must be 0 or greater.');
      }
      updates.push(
        this.configService.update(ConfigKey.DRIVER_CHARGE_FLAT, {
          key: ConfigKey.DRIVER_CHARGE_FLAT,
          value: String(dto.driverChargeFlat),
          dataType: 'number',
        }),
      );
    }

    if (dto.driverChargePercentage !== undefined) {
      if (dto.driverChargePercentage < 0 || dto.driverChargePercentage > 100) {
        throw new BadRequestException(
          'driverChargePercentage must be between 0 and 100.',
        );
      }
      updates.push(
        this.configService.update(ConfigKey.DRIVER_CHARGE_PERCENTAGE, {
          key: ConfigKey.DRIVER_CHARGE_PERCENTAGE,
          value: String(dto.driverChargePercentage),
          dataType: 'number',
        }),
      );
    }

    if (dto.driverChargeCap !== undefined) {
      if (dto.driverChargeCap < 0) {
        throw new BadRequestException('driverChargeCap must be 0 or greater.');
      }
      updates.push(
        this.configService.update(ConfigKey.DRIVER_CHARGE_CAP, {
          key: ConfigKey.DRIVER_CHARGE_CAP,
          value: String(dto.driverChargeCap),
          dataType: 'number',
        }),
      );
    }

    await Promise.all(updates);

    return this.getDriverSettings();
  }

  @Get('maps-settings')
  @ApiOperation({
    summary:
      'Get the Google Maps API key status (masked). Admin-only path that returns whether the key is set + the last 4 chars for visual confirmation, never the plaintext.',
  })
  async getMapsSettings(): Promise<{ configured: boolean; maskedKey: string }> {
    const key = await this.configService.getString(
      ConfigKey.GOOGLE_MAPS_API_KEY,
      '',
    );
    if (!key) return { configured: false, maskedKey: '' };
    const last4 = key.slice(-4);
    const masked = `${'•'.repeat(Math.max(0, key.length - 4))}${last4}`;
    return { configured: true, maskedKey: masked };
  }

  @Put('maps-settings')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Set the Google Maps API key (Admin only). Plaintext on POST.',
  })
  async updateMapsSettings(
    @Body() dto: UpdateMapsSettingsDto,
  ): Promise<{ configured: boolean; maskedKey: string }> {
    const value = (dto.apiKey ?? '').trim();
    await this.configService.update(ConfigKey.GOOGLE_MAPS_API_KEY, {
      key: ConfigKey.GOOGLE_MAPS_API_KEY,
      value,
      dataType: 'string',
    });
    return this.getMapsSettings();
  }

  @Get('allowed-id-types')
  @ApiOperation({
    summary:
      'DR-NEW — allowed DocumentType slugs for the driver ID picker. Any authenticated user reads this (the customer mobile picker bootstraps from it).',
  })
  async getAllowedIdTypes(): Promise<{ allowed: string[] }> {
    const value = await this.configService.get<string[]>(
      ConfigKey.ALLOWED_DRIVER_ID_TYPES,
      ['nin', 'drivers_license', 'passport', 'voters_card'],
    );
    return { allowed: Array.isArray(value) ? value : [] };
  }

  @Put('allowed-id-types')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Set the allowed DocumentType slugs for the driver ID picker (Admin only).',
  })
  async updateAllowedIdTypes(
    @Body() dto: UpdateAllowedIdTypesDto,
  ): Promise<{ allowed: string[] }> {
    const sanitized = Array.from(
      new Set(dto.allowed.map((s) => s.trim()).filter(Boolean)),
    );
    await this.configService.update(ConfigKey.ALLOWED_DRIVER_ID_TYPES, {
      key: ConfigKey.ALLOWED_DRIVER_ID_TYPES,
      value: JSON.stringify(sanitized),
      dataType: 'json',
    });
    return { allowed: sanitized };
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
