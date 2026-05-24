import { BadRequestException, Logger } from '@nestjs/common';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { ErrorCodes } from './constants/error-codes';

const geoLogger = new Logger('GeoZoneCheck');

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
    // Surface the coords + zone in the log so an admin can tell at a
    // glance whether the caller tested from outside Lagos vs the
    // bbox itself is misconfigured. The response message stays
    // customer-friendly per NFR-S3.
    geoLogger.warn(
      `ZONE_001 — point (${lat}, ${lng}) outside service zone ` +
        `[lat ${bbox.latMin}..${bbox.latMax}, lng ${bbox.lngMin}..${bbox.lngMax}]. ` +
        `Widen system_configs.${ConfigKey.LAGOS_SERVICE_BBOX} if this should be allowed.`,
    );
    throw new BadRequestException({
      errorCode: ErrorCodes.ZONE_001,
      message: `Pickup or drop-off is outside our operating zone (${lat.toFixed(4)}, ${lng.toFixed(4)}).`,
    });
  }
}

function deg2rad(deg: number): number {
  return deg * (Math.PI / 180);
}

// J2 — sanity bbox around Nigeria. Anything outside this is GPS drift,
// fixture leakage, or spoofing. Coarse on purpose; the Lagos service
// zone (ZONE_001) is the tight narrow filter on top.
export const NIGERIA_BBOX: LagosBbox = {
  latMin: 4.0,
  latMax: 14.0,
  lngMin: 2.5,
  lngMax: 15.0,
};

export function isInsideNigeria(lat: number, lng: number): boolean {
  return (
    lat >= NIGERIA_BBOX.latMin &&
    lat <= NIGERIA_BBOX.latMax &&
    lng >= NIGERIA_BBOX.lngMin &&
    lng <= NIGERIA_BBOX.lngMax
  );
}

/**
 * J2 — coarse-region check used at every coordinate ingress point
 * (driver location updates, order create pickup/dropoff). Surfaces as
 * `GEO_001` so the client can distinguish "you are out of Nigeria
 * entirely" from "you are out of the Lagos service zone" (ZONE_001).
 */
export function assertInsideNigeria(lat: number, lng: number): void {
  if (!isInsideNigeria(lat, lng)) {
    geoLogger.warn(
      `GEO_001 — point (${lat}, ${lng}) outside Nigeria bbox ` +
        `[lat ${NIGERIA_BBOX.latMin}..${NIGERIA_BBOX.latMax}, ` +
        `lng ${NIGERIA_BBOX.lngMin}..${NIGERIA_BBOX.lngMax}].`,
    );
    throw new BadRequestException({
      errorCode: ErrorCodes.GEO_001,
      message: `Coordinates (${lat.toFixed(4)}, ${lng.toFixed(4)}) fall outside our operating region. Verify GPS is on and accurate.`,
    });
  }
}

// J2 — NFR-P3 location-accuracy gate. Updates with `accuracy > 50m` are
// dropped silently (no DB write, no broadcast). Callers count dropped
// updates in a monitoring counter (logger.warn for v1).
export const MAX_LOCATION_ACCURACY_METERS = 50;

export function isAcceptableLocationAccuracy(
  accuracyMeters: number | null | undefined,
): boolean {
  if (accuracyMeters === null || accuracyMeters === undefined) {
    // No accuracy reading at all → accept. Older client builds
    // don't pass accuracy and we don't want to gate them out.
    return true;
  }
  return accuracyMeters <= MAX_LOCATION_ACCURACY_METERS;
}
