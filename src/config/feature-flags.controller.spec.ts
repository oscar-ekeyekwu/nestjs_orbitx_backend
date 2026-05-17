import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, CanActivate } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FeatureFlagsController } from './feature-flags.controller';
import { ConfigController } from './config.controller';
import { SystemConfigService } from './config.service';
import { ConfigKey } from './enums/config-keys.enum';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

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

// Integration test exercising the real NestJS routing layer.
// Validates that FeatureFlagsController's static `/config/feature-flags` route
// takes precedence over ConfigController's `/config/:key` parameterized route.
// Without correct registration order, GET /config/feature-flags would hit
// ConfigController (which is guarded by JwtAuthGuard) and return 401.
describe('FeatureFlagsController routing (integration)', () => {
  let app: INestApplication<App>;
  let configService: {
    getBoolean: jest.Mock;
    update: jest.Mock;
    get: jest.Mock;
  };

  // Stub guard that always denies — used by ConfigController routes.
  // FeatureFlagsController's GET has no guard, so this only matters for
  // confirming that /config/:key routes are still reachable & guarded.
  const denyAuthGuard: CanActivate = {
    canActivate: () => false,
  };

  beforeEach(async () => {
    configService = {
      getBoolean: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue('some-value'),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      // Order matches SystemConfigModule.controllers — FeatureFlagsController first.
      controllers: [FeatureFlagsController, ConfigController],
      providers: [{ provide: SystemConfigService, useValue: configService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(denyAuthGuard)
      .overrideGuard(RolesGuard)
      .useValue(denyAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /config/feature-flags resolves to FeatureFlagsController and is public', async () => {
    const response = await request(app.getHttpServer()).get(
      '/config/feature-flags',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ useMapView: true });
    // The mock on FeatureFlagsController's collaborator was hit.
    expect(configService.getBoolean).toHaveBeenCalledWith(
      ConfigKey.USE_MAP_VIEW,
      true,
    );
    // The fallback :key route on ConfigController was NOT hit.
    expect(configService.get).not.toHaveBeenCalled();
  });

  it('GET /config/:key still routes to ConfigController for arbitrary keys', async () => {
    // Any other path under /config/ falls through to ConfigController's `:key` route.
    // With JwtAuthGuard stubbed to deny, the expected response is 403 (Forbidden).
    const response = await request(app.getHttpServer()).get(
      '/config/SOME_OTHER_KEY',
    );

    expect(response.status).toBe(403);
    // FeatureFlagsController's collaborator was NOT hit.
    expect(configService.getBoolean).not.toHaveBeenCalled();
  });
});
