import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemConfigService } from './config.service';
import { ConfigController } from './config.controller';
import { FeatureFlagsController } from './feature-flags.controller';
import { SystemConfig } from './entities/system-config.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SystemConfig])],
  providers: [SystemConfigService],
  // FeatureFlagsController is registered first so its static `/config/feature-flags`
  // routes match before ConfigController's `:key` parameterized route.
  controllers: [FeatureFlagsController, ConfigController],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
