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
    getString: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    configService = {
      getBoolean: jest.fn().mockResolvedValue(true),
      getString: jest.fn().mockResolvedValue('continue'),
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
    it('returns { useMapView: true, vehicleEditGraceMode: "continue", orderPaymentProofRequired: false } when all config values default', async () => {
      // get() now calls getBoolean twice — first for USE_MAP_VIEW,
      // then for ORDER_PAYMENT_PROOF_REQUIRED. Mock both in order.
      configService.getBoolean
        .mockResolvedValueOnce(true) // USE_MAP_VIEW
        .mockResolvedValueOnce(false); // ORDER_PAYMENT_PROOF_REQUIRED
      configService.getString.mockResolvedValueOnce('continue');

      const result = await controller.get();

      expect(result).toEqual({
        useMapView: true,
        vehicleEditGraceMode: 'continue',
        orderPaymentProofRequired: false,
      });
      expect(configService.getBoolean).toHaveBeenCalledWith(
        ConfigKey.USE_MAP_VIEW,
        true,
      );
      expect(configService.getBoolean).toHaveBeenCalledWith(
        ConfigKey.ORDER_PAYMENT_PROOF_REQUIRED,
        false,
      );
      expect(configService.getString).toHaveBeenCalledWith(
        ConfigKey.VEHICLE_EDIT_GRACE_MODE,
        'continue',
      );
    });

    it('returns vehicleEditGraceMode: "lock" when the config value is "lock"', async () => {
      configService.getBoolean
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      configService.getString.mockResolvedValueOnce('lock');

      const result = await controller.get();

      expect(result).toEqual({
        useMapView: true,
        vehicleEditGraceMode: 'lock',
        orderPaymentProofRequired: false,
      });
    });

    it('collapses any unknown grace-mode value to "continue" (safer default)', async () => {
      configService.getBoolean
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      configService.getString.mockResolvedValueOnce('garbage');

      const result = await controller.get();

      expect(result.vehicleEditGraceMode).toBe('continue');
    });

    it('returns { useMapView: false } when USE_MAP_VIEW is off', async () => {
      configService.getBoolean
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      configService.getString.mockResolvedValueOnce('continue');

      const result = await controller.get();

      expect(result.useMapView).toBe(false);
    });

    it('returns orderPaymentProofRequired: true when the flag is on', async () => {
      configService.getBoolean
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      configService.getString.mockResolvedValueOnce('continue');

      const result = await controller.get();
      expect(result.orderPaymentProofRequired).toBe(true);
    });
  });

  describe('PUT /config/feature-flags', () => {
    it('updates only useMapView when only useMapView is present in the body', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean
        .mockResolvedValueOnce(false) // USE_MAP_VIEW post-write read
        .mockResolvedValueOnce(false); // ORDER_PAYMENT_PROOF_REQUIRED read
      configService.getString.mockResolvedValueOnce('continue');

      const result = await controller.update({ useMapView: false });

      expect(configService.update).toHaveBeenCalledTimes(1);
      expect(configService.update).toHaveBeenCalledWith(
        ConfigKey.USE_MAP_VIEW,
        {
          key: ConfigKey.USE_MAP_VIEW,
          value: 'false',
          dataType: 'boolean',
        },
      );
      expect(result).toEqual({
        useMapView: false,
        vehicleEditGraceMode: 'continue',
        orderPaymentProofRequired: false,
      });
    });

    it('updates only vehicleEditGraceMode when only that field is present', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      configService.getString.mockResolvedValueOnce('lock');

      const result = await controller.update({ vehicleEditGraceMode: 'lock' });

      expect(configService.update).toHaveBeenCalledTimes(1);
      expect(configService.update).toHaveBeenCalledWith(
        ConfigKey.VEHICLE_EDIT_GRACE_MODE,
        {
          key: ConfigKey.VEHICLE_EDIT_GRACE_MODE,
          value: 'lock',
          dataType: 'string',
        },
      );
      expect(result.vehicleEditGraceMode).toBe('lock');
    });

    it('updates orderPaymentProofRequired when present in body', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      configService.getString.mockResolvedValueOnce('continue');

      const result = await controller.update({
        orderPaymentProofRequired: true,
      });

      expect(configService.update).toHaveBeenCalledTimes(1);
      expect(configService.update).toHaveBeenCalledWith(
        ConfigKey.ORDER_PAYMENT_PROOF_REQUIRED,
        {
          key: ConfigKey.ORDER_PAYMENT_PROOF_REQUIRED,
          value: 'true',
          dataType: 'boolean',
        },
      );
      expect(result.orderPaymentProofRequired).toBe(true);
    });

    it('updates all fields when all are present in the body', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      configService.getString.mockResolvedValueOnce('continue');

      await controller.update({
        useMapView: true,
        vehicleEditGraceMode: 'continue',
        orderPaymentProofRequired: true,
      });

      expect(configService.update).toHaveBeenCalledTimes(3);
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
    getString: jest.Mock;
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
      getString: jest.fn().mockResolvedValue('continue'),
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
    expect(response.body).toEqual({
      useMapView: true,
      vehicleEditGraceMode: 'continue',
      // Default mock returns true; the controller maps any truthy
      // boolean through, so the integration sees true here. The
      // production default seeded by the migration is 'false'.
      orderPaymentProofRequired: true,
    });
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
