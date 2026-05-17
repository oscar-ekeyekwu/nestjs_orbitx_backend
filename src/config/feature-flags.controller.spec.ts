import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagsController } from './feature-flags.controller';
import { SystemConfigService } from './config.service';
import { ConfigKey } from './enums/config-keys.enum';

describe('FeatureFlagsController', () => {
  let controller: FeatureFlagsController;
  let configService: {
    getBoolean: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    configService = {
      getBoolean: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeatureFlagsController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    controller = module.get<FeatureFlagsController>(FeatureFlagsController);
  });

  describe('GET /config/feature-flags', () => {
    it('returns { useMapView: true } when config value is true', async () => {
      configService.getBoolean.mockResolvedValue(true);

      const result = await controller.get();

      expect(result).toEqual({ useMapView: true });
      expect(configService.getBoolean).toHaveBeenCalledWith(
        ConfigKey.USE_MAP_VIEW,
        true,
      );
    });

    it('returns { useMapView: false } when config value is false', async () => {
      configService.getBoolean.mockResolvedValue(false);

      const result = await controller.get();

      expect(result).toEqual({ useMapView: false });
    });

    it('uses default true when the config key is missing', async () => {
      // The default is enforced by SystemConfigService.getBoolean, which the
      // controller passes `true` as default. Mock returns the default-applied value.
      configService.getBoolean.mockResolvedValue(true);

      const result = await controller.get();

      expect(result).toEqual({ useMapView: true });
      expect(configService.getBoolean).toHaveBeenCalledWith(
        ConfigKey.USE_MAP_VIEW,
        true,
      );
    });
  });

  describe('PUT /config/feature-flags', () => {
    it('updates the USE_MAP_VIEW config to false and returns the new state', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean.mockResolvedValue(false);

      const result = await controller.update({ useMapView: false });

      expect(configService.update).toHaveBeenCalledWith(
        ConfigKey.USE_MAP_VIEW,
        {
          key: ConfigKey.USE_MAP_VIEW,
          value: 'false',
          dataType: 'boolean',
        },
      );
      expect(result).toEqual({ useMapView: false });
    });

    it('updates the USE_MAP_VIEW config to true and returns the new state', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean.mockResolvedValue(true);

      const result = await controller.update({ useMapView: true });

      expect(configService.update).toHaveBeenCalledWith(
        ConfigKey.USE_MAP_VIEW,
        {
          key: ConfigKey.USE_MAP_VIEW,
          value: 'true',
          dataType: 'boolean',
        },
      );
      expect(result).toEqual({ useMapView: true });
    });
  });
});
