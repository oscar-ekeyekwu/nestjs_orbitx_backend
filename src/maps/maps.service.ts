import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SystemConfigService } from '../config/config.service';
import { ConfigKey } from '../config/enums/config-keys.enum';

export interface PlaceSuggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface PlaceDetails {
  latitude: number;
  longitude: number;
  address: string;
}

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  address: string;
}

/**
 * Maps proxy. Mobile clients never see the Google API key — every
 * call goes through this service. The key is resolved at call time
 * from `system_configs.GOOGLE_MAPS_API_KEY` so an admin can rotate it
 * without a redeploy.
 *
 * Endpoints called:
 *  - Places Autocomplete v1 (legacy `/place/autocomplete/json`) for
 *    typeahead suggestions.
 *  - Places Details v1 (legacy `/place/details/json`) for resolving a
 *    selected suggestion's coordinates.
 *  - Geocoding API for free-text → coords (fallback when the user
 *    skips the autocomplete path).
 *  - Reverse Geocoding API for coords → address.
 *
 * All upstream errors get a 503 so the mobile UI can show a clear
 * "maps temporarily unavailable" message instead of leaking Google
 * status strings.
 */
@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);

  constructor(private readonly configService: SystemConfigService) {}

  private async getKey(): Promise<string> {
    const key = await this.configService.getString(
      ConfigKey.GOOGLE_MAPS_API_KEY,
      '',
    );
    if (!key) {
      throw new ServiceUnavailableException({
        message:
          'Maps service is not configured. Ask an administrator to set the Google Maps API key.',
      });
    }
    return key;
  }

  async autocomplete(
    input: string,
    sessionToken?: string,
  ): Promise<PlaceSuggestion[]> {
    if (!input || input.trim().length < 3) return [];
    const key = await this.getKey();

    const params = new URLSearchParams({
      input: input.trim(),
      key,
      language: 'en',
      types: 'address|establishment',
    });
    if (sessionToken) params.set('sessiontoken', sessionToken);

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`;
    const data = await this.fetchJson(url, 'places.autocomplete');

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      this.logger.warn(
        `Places autocomplete returned status=${data.status} for input=${input}`,
      );
      return [];
    }
    const predictions = Array.isArray(data.predictions) ? data.predictions : [];
    return predictions.map(
      (p: {
        place_id: string;
        description: string;
        structured_formatting?: { main_text?: string; secondary_text?: string };
      }) => ({
        placeId: p.place_id,
        description: p.description,
        mainText: p.structured_formatting?.main_text ?? p.description,
        secondaryText: p.structured_formatting?.secondary_text ?? '',
      }),
    );
  }

  async placeDetails(
    placeId: string,
    sessionToken?: string,
  ): Promise<PlaceDetails> {
    if (!placeId) {
      throw new BadRequestException('placeId is required.');
    }
    const key = await this.getKey();

    const params = new URLSearchParams({
      place_id: placeId,
      key,
      fields: 'geometry,formatted_address',
    });
    if (sessionToken) params.set('sessiontoken', sessionToken);

    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;
    const data = await this.fetchJson(url, 'places.details');

    const result = data.result as
      | {
          geometry?: { location?: { lat: number; lng: number } };
          formatted_address?: string;
        }
      | undefined;
    if (data.status !== 'OK' || !result) {
      this.logger.warn(
        `Places details returned status=${data.status} for placeId=${placeId}`,
      );
      throw new ServiceUnavailableException({
        message: 'Could not resolve the selected place. Try another address.',
      });
    }
    return {
      latitude: result.geometry?.location?.lat ?? 0,
      longitude: result.geometry?.location?.lng ?? 0,
      address: result.formatted_address ?? '',
    };
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    if (!address || address.trim().length === 0) return null;
    const key = await this.getKey();

    const params = new URLSearchParams({
      address: address.trim(),
      key,
      region: 'ng',
    });
    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
    const data = await this.fetchJson(url, 'geocode');

    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      if (data.status !== 'ZERO_RESULTS') {
        this.logger.warn(
          `Geocode returned status=${data.status} for address=${address}`,
        );
      }
      return null;
    }
    const first = data.results[0];
    const lat = first.geometry?.location?.lat;
    const lng = first.geometry?.location?.lng;
    if (lat == null || lng == null) return null;
    return {
      latitude: lat,
      longitude: lng,
      address: first.formatted_address ?? address.trim(),
    };
  }

  async reverseGeocode(
    latitude: number,
    longitude: number,
  ): Promise<string | null> {
    const key = await this.getKey();
    const params = new URLSearchParams({
      latlng: `${latitude},${longitude}`,
      key,
    });
    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
    const data = await this.fetchJson(url, 'reverseGeocode');

    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      if (data.status !== 'ZERO_RESULTS') {
        this.logger.warn(
          `Reverse geocode returned status=${data.status} for ${latitude},${longitude}`,
        );
      }
      return null;
    }
    return data.results[0].formatted_address as string;
  }

  // Light fetch wrapper with a fixed 8s upper bound so a slow Google
  // call doesn't pile up backend connections during a usage spike.
  private async fetchJson(
    url: string,
    op: string,
  ): Promise<{
    status?: string;
    result?: unknown;
    results?: Array<{
      geometry?: { location?: { lat: number; lng: number } };
      formatted_address?: string;
    }>;
    predictions?: unknown[];
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.logger.warn(`Maps ${op} HTTP ${res.status}`);
        throw new ServiceUnavailableException({
          message: 'Maps service is temporarily unavailable. Try again.',
        });
      }
      return (await res.json()) as {
        status?: string;
        result?: unknown;
        results?: Array<{
          geometry?: { location?: { lat: number; lng: number } };
          formatted_address?: string;
        }>;
        predictions?: unknown[];
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Maps ${op} failed: ${message}`);
      throw new ServiceUnavailableException({
        message: 'Maps service is temporarily unavailable. Try again.',
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
