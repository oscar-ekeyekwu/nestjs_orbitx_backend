import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemConfigService } from './config.service';
import { ConfigKey } from './enums/config-keys.enum';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

export type VehicleEditGraceMode = 'continue' | 'lock';

class UpdateFeatureFlagsDto {
  @IsOptional()
  @IsBoolean()
  useMapView?: boolean;

  @IsOptional()
  @IsIn(['continue', 'lock'])
  vehicleEditGraceMode?: VehicleEditGraceMode;

  // Phase 3 — when true, customers must attach a screenshot of their
  // bank transfer at customer_marked_paid time.
  @IsOptional()
  @IsBoolean()
  orderPaymentProofRequired?: boolean;
}

interface FeatureFlagsResponse {
  useMapView: boolean;
  vehicleEditGraceMode: VehicleEditGraceMode;
  orderPaymentProofRequired: boolean;
}

@ApiTags('Configuration')
@Controller('config/feature-flags')
export class FeatureFlagsController {
  constructor(private readonly configService: SystemConfigService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get public feature flag values. Unauthenticated — consumed by mobile and admin clients.',
  })
  async get(): Promise<FeatureFlagsResponse> {
    const useMapView = await this.configService.getBoolean(
      ConfigKey.USE_MAP_VIEW,
      true,
    );
    // F3 — surfaces the F2 lock-mode toggle through the same endpoint
    // the admin Feature Settings page already polls. Anything other
    // than the literal "lock" string collapses to "continue" — same
    // safer-default semantics as VehiclePendingUpdatesService.getGraceMode.
    const raw = await this.configService.getString(
      ConfigKey.VEHICLE_EDIT_GRACE_MODE,
      'continue',
    );
    const vehicleEditGraceMode: VehicleEditGraceMode =
      raw === 'lock' ? 'lock' : 'continue';
    const orderPaymentProofRequired = await this.configService.getBoolean(
      ConfigKey.ORDER_PAYMENT_PROOF_REQUIRED,
      false,
    );
    return { useMapView, vehicleEditGraceMode, orderPaymentProofRequired };
  }

  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update feature flag values (Admin only)' })
  async update(
    @Body() dto: UpdateFeatureFlagsDto,
  ): Promise<FeatureFlagsResponse> {
    if (dto.useMapView !== undefined) {
      await this.configService.update(ConfigKey.USE_MAP_VIEW, {
        key: ConfigKey.USE_MAP_VIEW,
        value: String(dto.useMapView),
        dataType: 'boolean',
      });
    }
    if (dto.vehicleEditGraceMode !== undefined) {
      await this.configService.update(ConfigKey.VEHICLE_EDIT_GRACE_MODE, {
        key: ConfigKey.VEHICLE_EDIT_GRACE_MODE,
        value: dto.vehicleEditGraceMode,
        dataType: 'string',
      });
    }
    if (dto.orderPaymentProofRequired !== undefined) {
      await this.configService.update(ConfigKey.ORDER_PAYMENT_PROOF_REQUIRED, {
        key: ConfigKey.ORDER_PAYMENT_PROOF_REQUIRED,
        value: String(dto.orderPaymentProofRequired),
        dataType: 'boolean',
      });
    }
    return this.get();
  }
}
