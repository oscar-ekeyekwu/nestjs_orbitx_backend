import { Body, Controller, Get, Logger, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemConfigService } from './config.service';
import { ConfigKey } from './enums/config-keys.enum';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
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
  private readonly logger = new Logger(FeatureFlagsController.name);

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
    @CurrentUser() user?: User,
  ): Promise<FeatureFlagsResponse> {
    // Snapshot pre-write state so the audit log can diff the change.
    const before = await this.get();

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

    const after = await this.get();

    // Structured audit log line — kept lightweight (no DB write) so
    // this commit doesn't need a migration. Centralised aggregator
    // (Loki/Datadog) ingests `system_config.changed` to attribute
    // ops-affecting flag flips to a named admin.
    this.logFlagDiff('useMapView', before.useMapView, after.useMapView, user);
    this.logFlagDiff(
      'vehicleEditGraceMode',
      before.vehicleEditGraceMode,
      after.vehicleEditGraceMode,
      user,
    );
    this.logFlagDiff(
      'orderPaymentProofRequired',
      before.orderPaymentProofRequired,
      after.orderPaymentProofRequired,
      user,
    );

    return after;
  }

  private logFlagDiff(
    name: string,
    prev: unknown,
    next: unknown,
    user?: User,
  ): void {
    if (prev === next) return;
    this.logger.log(
      `system_config.changed flag=${name} prev=${JSON.stringify(prev)} next=${JSON.stringify(next)} actor=${user?.id ?? 'unknown'} actorEmail=${user?.email ?? 'unknown'}`,
    );
  }
}
