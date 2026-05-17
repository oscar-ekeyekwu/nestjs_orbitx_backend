import { BadRequestException } from '@nestjs/common';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { ErrorCodes } from './constants/error-codes';
import {
  LagosBbox,
  assertInsideLagos,
  haversineKm,
  isInsideLagos,
} from './geo';

const LAGOS: LagosBbox = {
  latMin: 6.35,
  latMax: 6.7,
  lngMin: 3.1,
  lngMax: 3.55,
};

describe('geo (ARCH-5)', () => {
  describe('isInsideLagos', () => {
    it('returns true for a known Lagos point (Victoria Island)', () => {
      expect(isInsideLagos(6.4281, 3.4219, LAGOS)).toBe(true);
    });

    it('returns true for the four corners (boundaries inclusive)', () => {
      expect(isInsideLagos(LAGOS.latMin, LAGOS.lngMin, LAGOS)).toBe(true);
      expect(isInsideLagos(LAGOS.latMin, LAGOS.lngMax, LAGOS)).toBe(true);
      expect(isInsideLagos(LAGOS.latMax, LAGOS.lngMin, LAGOS)).toBe(true);
      expect(isInsideLagos(LAGOS.latMax, LAGOS.lngMax, LAGOS)).toBe(true);
    });

    it('returns true for points exactly on the top edge (lat=6.70)', () => {
      expect(isInsideLagos(6.7, 3.4, LAGOS)).toBe(true);
    });

    it('returns false for points just outside each edge', () => {
      expect(isInsideLagos(LAGOS.latMin - 0.001, 3.4, LAGOS)).toBe(false);
      expect(isInsideLagos(LAGOS.latMax + 0.001, 3.4, LAGOS)).toBe(false);
      expect(isInsideLagos(6.5, LAGOS.lngMin - 0.001, LAGOS)).toBe(false);
      expect(isInsideLagos(6.5, LAGOS.lngMax + 0.001, LAGOS)).toBe(false);
    });

    it('returns false for far-away points (Abuja, Accra)', () => {
      expect(isInsideLagos(9.0765, 7.3986, LAGOS)).toBe(false); // Abuja
      expect(isInsideLagos(5.6037, -0.187, LAGOS)).toBe(false); // Accra
    });
  });

  describe('haversineKm', () => {
    it('returns 0 for two identical points', () => {
      expect(haversineKm(6.5, 3.4, 6.5, 3.4)).toBeCloseTo(0, 6);
    });

    it('matches the known Lagos → Abuja great-circle distance (~525 km)', () => {
      // Lagos centre vs Abuja centre. Tolerance is generous (515-540 km)
      // because the haversine formula assumes a perfect sphere; WGS84
      // (geodesic) gives a slightly different number, and the published
      // "Lagos to Abuja" figures vary by source (533 km road, ~525 km
      // great-circle).
      const km = haversineKm(6.4281, 3.4219, 9.0765, 7.3986);
      expect(km).toBeGreaterThan(515);
      expect(km).toBeLessThan(540);
    });

    it('returns a small distance for two nearby Lagos points', () => {
      // Ikoyi → Lekki Phase 1 — roughly 7 km via great-circle.
      const km = haversineKm(6.4474, 3.4356, 6.4359, 3.4824);
      expect(km).toBeGreaterThan(4);
      expect(km).toBeLessThan(10);
    });
  });

  describe('assertInsideLagos', () => {
    function configWith(bbox: LagosBbox): {
      service: SystemConfigService;
      get: jest.Mock;
    } {
      const get = jest.fn().mockResolvedValue(bbox);
      const service = { get } as unknown as SystemConfigService;
      return { service, get };
    }

    it('resolves the bbox from SystemConfigService and accepts an inside point', async () => {
      const { service, get } = configWith(LAGOS);
      await expect(
        assertInsideLagos(6.5, 3.4, service),
      ).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledWith(
        ConfigKey.LAGOS_SERVICE_BBOX,
        expect.any(Object),
      );
    });

    it('throws BadRequestException ZONE_001 for an outside point', async () => {
      const { service } = configWith(LAGOS);

      let caught: unknown;
      try {
        await assertInsideLagos(9.0765, 7.3986, service); // Abuja
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errorCode: string;
        message: string;
      };
      expect(response.errorCode).toBe(ErrorCodes.ZONE_001);
      expect(response.message).toBe('You are outside our operating zone.');
    });

    it('picks up a different bbox if the config service returns one (admin-tunable)', async () => {
      // Narrower bbox — Victoria Island would now be outside.
      const tight: LagosBbox = {
        latMin: 6.6,
        latMax: 6.7,
        lngMin: 3.3,
        lngMax: 3.4,
      };
      const { service } = configWith(tight);

      await expect(
        assertInsideLagos(6.4281, 3.4219, service),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
