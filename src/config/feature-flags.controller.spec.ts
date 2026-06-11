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
    /**
     * update() now reads the flag state both before AND after the
     * write so the audit log can diff. Each test below uses always-
     * returns mocks (mockResolvedValue) so both reads see the same
     * post-write values — matches what production sees once the
     * write commits and saves us threading two-pass ordering through
     * every assertion.
     */
    it('updates only useMapView when only useMapView is present in the body', async () => {
      configService.update.mockResolvedValue(undefined);
      configService.getBoolean.mockImplementation(async (key: string) =>
        key === ConfigKey.USE_MAP_VIEW ? false : false,
      );
      configService.getString.mockResolvedValue('continue');

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
      configService.getBoolean.mockResolvedValue(true);
      configService.getString.mockResolvedValue('lock');

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
      configService.getBoolean.mockResolvedValue(true);
      configService.getString.mockResolvedValue('continue');

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
      configService.getBoolean.mockResolvedValue(true);
      configService.getString.mockResolvedValue('continue');

      await controller.update({
        useMapView: true,
        vehicleEditGraceMode: 'continue',
        orderPaymentProofRequired: true,
      });

      expect(configService.update).toHaveBeenCalledTimes(3);
    });

    it('emits an audit log line attributing the flag flip to the actor', async () => {
      configService.update.mockResolvedValue(undefined);
      // Stateful before/after — first call returns previous state
      // (false), subsequent calls return next state (true). The
      // controller invokes getBoolean twice for each get() call
      // (USE_MAP_VIEW then ORDER_PAYMENT_PROOF_REQUIRED).
      const sequence = [false, false, true, true]; // before, before, after, after
      let i = 0;
      configService.getBoolean.mockImplementation(async () => {
        return sequence[i++] ?? true;
      });
      configService.getString.mockResolvedValue('continue');

      const logSpy = jest
        .spyOn(
          (controller as unknown as { logger: { log: jest.Mock } }).logger,
          'log',
        )
        .mockImplementation(() => undefined);

      await controller.update(
        { orderPaymentProofRequired: true },
        {
          id: 'admin-1',
          email: 'jane@orbit.com',
        } as unknown as Parameters<typeof controller.update>[1],
      );

      const audited = logSpy.mock.calls.find(([msg]) =>
        String(msg).includes('orderPaymentProofRequired'),
      );
      expect(audited).toBeDefined();
      const line = String(audited![0]);
      expect(line).toMatch(/system_config\.changed/);
      expect(line).toMatch(/prev=false/);
      expect(line).toMatch(/next=true/);
      expect(line).toMatch(/actor=admin-1/);
      expect(line).toMatch(/actorEmail=jane@orbit\.com/);
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
