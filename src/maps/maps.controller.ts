import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength, Min, Max } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MapsService } from './maps.service';

class AutocompleteDto {
  @IsString()
  @MaxLength(200)
  input: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionToken?: string;
}

class PlaceDetailsDto {
  @IsString()
  @MaxLength(200)
  placeId: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionToken?: string;
}

class GeocodeDto {
  @IsString()
  @MaxLength(300)
  address: string;
}

class ReverseGeocodeDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;
}

/**
 * Maps proxy — every authenticated client (customer + driver) hits
 * these endpoints; the Google API key stays on the backend.
 *
 * Throttling: autocomplete fires per-keystroke (debounced client-
 * side) so we lift the per-IP ceiling above the global 100/min.
 * Geocode + reverse-geocode are at most one call per address blur
 * and stay on the default ceiling.
 */
@ApiTags('Maps')
@ApiBearerAuth()
@Controller('maps')
@UseGuards(JwtAuthGuard)
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  @Post('places/autocomplete')
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @ApiOperation({
    summary: 'Proxy Google Places Autocomplete — returns suggestion list',
  })
  autocomplete(@Body() dto: AutocompleteDto) {
    return this.mapsService.autocomplete(dto.input, dto.sessionToken);
  }

  @Post('places/details')
  @ApiOperation({
    summary: 'Proxy Google Place Details — resolve a placeId to coordinates',
  })
  placeDetails(@Body() dto: PlaceDetailsDto) {
    return this.mapsService.placeDetails(dto.placeId, dto.sessionToken);
  }

  @Post('geocode')
  @ApiOperation({
    summary: 'Proxy Google Geocoding — free-text address → coordinates',
  })
  geocode(@Body() dto: GeocodeDto) {
    return this.mapsService.geocode(dto.address);
  }

  @Post('reverse-geocode')
  @ApiOperation({
    summary: 'Proxy Google Reverse Geocoding — coordinates → formatted address',
  })
  reverseGeocode(@Body() dto: ReverseGeocodeDto) {
    return this.mapsService.reverseGeocode(dto.latitude, dto.longitude);
  }
}
