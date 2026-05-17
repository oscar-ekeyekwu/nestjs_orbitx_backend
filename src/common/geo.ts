import { BadRequestException } from '@nestjs/common';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { ErrorCodes } from './constants/error-codes';

/**
 * Inclusive bounding box. Matches the JSON shape stored under
 * `system_configs.LAGOS_SERVICE_BBOX`.
 */
export interface LagosBbox {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

const DEFAULT_LAGOS_BBOX: LagosBbox = {
  latMin: 6.35,
  latMax: 6.7,
  lngMin: 3.1,
  lngMax: 3.55,
};

/**
 * Great-circle distance in kilometres between two `(lat, lng)` points,
 * using the haversine formula. Earth's mean radius is 6371 km.
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLng = deg2rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Pure inclusion check against a bounding box. Edges are **inclusive**
 * (a point on `latMax` or `lngMin` is considered inside).
 */
export function isInsideLagos(
  lat: number,
  lng: number,
  bbox: LagosBbox = DEFAULT_LAGOS_BBOX,
): boolean {
  return (
    lat >= bbox.latMin &&
    lat <= bbox.latMax &&
    lng >= bbox.lngMin &&
    lng <= bbox.lngMax
  );
}

/**
 * Resolve the bbox from `system_configs.LAGOS_SERVICE_BBOX` and throw a
 * customer-friendly 400 / `ZONE_001` if the supplied point is outside.
 *
 * Identical signature to the v1.1 PostGIS replacement
 * (`ST_Contains(service_zone, ST_Point(lng, lat))`), so call sites in
 * DriversService.updateOnlineStatus and OrdersService.create won't need
 * to change when we cut over to a real polygon.
 */
export async function assertInsideLagos(
  lat: number,
  lng: number,
  configService: SystemConfigService,
): Promise<void> {
  const bbox = await configService.get<LagosBbox>(
    ConfigKey.LAGOS_SERVICE_BBOX,
    DEFAULT_LAGOS_BBOX,
  );
  if (!isInsideLagos(lat, lng, bbox)) {
    throw new BadRequestException({
      errorCode: ErrorCodes.ZONE_001,
      message: 'You are outside our operating zone.',
    });
  }
}

function deg2rad(deg: number): number {
  return deg * (Math.PI / 180);
}
