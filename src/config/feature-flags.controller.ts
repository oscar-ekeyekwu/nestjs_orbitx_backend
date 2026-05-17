import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemConfigService } from './config.service';
import { ConfigKey } from './enums/config-keys.enum';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

class UpdateFeatureFlagsDto {
  @IsBoolean()
  useMapView!: boolean;
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
  async get(): Promise<{ useMapView: boolean }> {
    const useMapView = await this.configService.getBoolean(
      ConfigKey.USE_MAP_VIEW,
      true,
    );
    return { useMapView };
  }

  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update feature flag values (Admin only)' })
  async update(
    @Body() dto: UpdateFeatureFlagsDto,
  ): Promise<{ useMapView: boolean }> {
    await this.configService.update(ConfigKey.USE_MAP_VIEW, {
      key: ConfigKey.USE_MAP_VIEW,
      value: String(dto.useMapView),
      dataType: 'boolean',
    });
    return this.get();
  }
}
