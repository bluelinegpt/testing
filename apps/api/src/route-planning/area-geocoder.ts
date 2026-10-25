import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { RoutePoint } from "./route-provider.js";

/**
 * Area pin suggestions from Google Geocoding (Aiman, 25 Oct 2026).
 *
 * Only ever produces a *suggestion*: an administrator accepts or rejects it,
 * and only an accepted pin is routed on. A result is flagged -- and so never
 * accepted in bulk -- when Google found nothing, matched only loosely,
 * returned the whole city rather than the Area, or placed it outside the
 * Area's Emirate.
 *
 * The key is read from the environment (`GOOGLE_MAPS_API_KEY`) and never
 * logged, returned or stored.
 */

export type SuggestionFlag = "not_found" | "outside_emirate" | "city_level" | "partial_match";

export interface GeocodeOutcome {
  readonly point: RoutePoint | null;
  readonly formattedAddress: string | null;
  readonly resultTypes: readonly string[];
  readonly partialMatch: boolean;
}

export interface GeocodeArea {
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly emirateCode: string;
  readonly emirateNameEn: string;
}

interface Box {
  readonly south: number;
  readonly north: number;
  readonly west: number;
  readonly east: number;
}

/**
 * Generous Emirate boxes (exclaves included), only to catch a result in the
 * wrong Emirate -- "Al Nahda" Sharjah returned for "Al Nahda" Dubai, say.
 */
const EMIRATE_BOXES: Readonly<Record<string, readonly Box[]>> = {
  AUH: [{ south: 22.5, north: 25.4, west: 51.0, east: 56.1 }],
  WST: [{ south: 22.5, north: 24.6, west: 51.0, east: 54.2 }],
  AAN: [{ south: 23.6, north: 24.5, west: 55.3, east: 56.1 }],
  OAA: [{ south: 22.5, north: 24.9, west: 54.0, east: 56.1 }],
  DXB: [
    { south: 24.6, north: 25.42, west: 54.85, east: 55.7 },
    { south: 24.7, north: 24.9, west: 55.95, east: 56.25 }, // Hatta
  ],
  SHJ: [
    { south: 24.9, north: 25.45, west: 55.3, east: 56.0 },
    { south: 24.95, north: 25.45, west: 56.2, east: 56.45 }, // Kalba, Khor Fakkan, Dibba Al Hisn
  ],
  AJM: [
    { south: 25.33, north: 25.5, west: 55.38, east: 55.65 },
    { south: 24.75, north: 25.35, west: 55.9, east: 56.2 }, // Masfout, Al Manama
  ],
  UAQ: [{ south: 25.3, north: 25.75, west: 55.5, east: 56.0 }],
  RAK: [{ south: 25.3, north: 26.2, west: 55.7, east: 56.3 }],
  FUJ: [{ south: 24.9, north: 25.75, west: 55.9, east: 56.45 }],
};
const BOX_MARGIN = 0.03;

/** Types that mean Google returned the city or Emirate, not the Area. */
const CITY_LEVEL_TYPES = new Set([
  "locality",
  "political",
  "administrative_area_level_1",
  "administrative_area_level_2",
  "country",
  "colloquial_area",
]);

/** Where to look for an Area: the city its Emirate entry stands for. */
export function geocodeQuery(area: GeocodeArea): string {
  const city =
    area.emirateCode === "AAN" || area.emirateCode === "OAA"
      ? "Al Ain"
      : area.emirateCode === "WST"
        ? "Al Dhafra, Abu Dhabi"
        : area.emirateCode === "EST"
          ? ""
          : area.emirateNameEn;
  const name = area.nameEn.trim() === "" ? (area.nameAr ?? "").trim() : area.nameEn.trim();
  return [name, city, "United Arab Emirates"].filter((part) => part !== "").join(", ");
}

export function insideEmirate(emirateCode: string, point: RoutePoint): boolean {
  const boxes = EMIRATE_BOXES[emirateCode];
  if (boxes === undefined) return true; // no box known: do not second-guess
  return boxes.some(
    (box) =>
      point.latitude >= box.south - BOX_MARGIN &&
      point.latitude <= box.north + BOX_MARGIN &&
      point.longitude >= box.west - BOX_MARGIN &&
      point.longitude <= box.east + BOX_MARGIN,
  );
}

export function suggestionFlag(emirateCode: string, outcome: GeocodeOutcome): SuggestionFlag | null {
  if (outcome.point === null) return "not_found";
  if (!insideEmirate(emirateCode, outcome.point)) return "outside_emirate";
  if (outcome.resultTypes.length > 0 && outcome.resultTypes.every((type) => CITY_LEVEL_TYPES.has(type))) {
    return "city_level";
  }
  if (outcome.partialMatch) return "partial_match";
  return null;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export const GEOCODER_FETCH = Symbol("GEOCODER_FETCH");

interface GoogleGeocodeResponse {
  readonly status?: string;
  readonly results?: readonly {
    readonly formatted_address?: string;
    readonly types?: readonly string[];
    readonly partial_match?: boolean;
    readonly geometry?: { readonly location?: { readonly lat?: number; readonly lng?: number } };
  }[];
}

/** Google said stop for now (quota or rate); the batch ends without error. */
export class GeocoderQuotaReached extends Error {}

@Injectable()
export class AreaGeocoder {
  private readonly key: string | undefined;

  public constructor(
    @Inject(ConfigService) config: ConfigService<AppConfiguration, true>,
    @Inject(GEOCODER_FETCH) private readonly fetcher: FetchLike,
  ) {
    this.key = config.get("routing", { infer: true })?.googleMapsApiKey;
  }

  public get configured(): boolean {
    return this.key !== undefined;
  }

  public async geocode(query: string): Promise<GeocodeOutcome> {
    if (this.key === undefined) throw geocoderNotConfigured();
    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      `?address=${encodeURIComponent(query)}` +
      "&components=country:AE&region=ae&language=en" +
      `&key=${encodeURIComponent(this.key)}`;
    let body: GoogleGeocodeResponse;
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (response.status === 429) throw new GeocoderQuotaReached();
      body = (await response.json()) as GoogleGeocodeResponse;
    } catch (error) {
      if (error instanceof GeocoderQuotaReached) throw error;
      // Never surface the underlying error: it may carry the request URL.
      throw new ApplicationException(
        "route_geocoding_unreachable",
        "Google could not be reached. Try again in a minute.",
        HttpStatus.BAD_GATEWAY,
      );
    }
    switch (body.status) {
      case "OK":
        break;
      case "ZERO_RESULTS":
        return { point: null, formattedAddress: null, resultTypes: [], partialMatch: false };
      case "OVER_QUERY_LIMIT":
      case "OVER_DAILY_LIMIT":
        throw new GeocoderQuotaReached();
      case "REQUEST_DENIED":
        throw new ApplicationException(
          "route_geocoding_denied",
          "Google refused the request. Check that the Geocoding API is enabled for the Google Maps key and that billing is on.",
          HttpStatus.BAD_GATEWAY,
        );
      default:
        throw new ApplicationException(
          "route_geocoding_failed",
          "Google could not look this Area up. Try again later.",
          HttpStatus.BAD_GATEWAY,
        );
    }
    const first = body.results?.[0];
    const lat = first?.geometry?.location?.lat;
    const lng = first?.geometry?.location?.lng;
    if (first === undefined || typeof lat !== "number" || typeof lng !== "number") {
      return { point: null, formattedAddress: null, resultTypes: [], partialMatch: false };
    }
    return {
      point: { latitude: round6(lat), longitude: round6(lng) },
      formattedAddress: first.formatted_address ?? null,
      resultTypes: first.types ?? [],
      partialMatch: first.partial_match === true,
    };
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function geocoderNotConfigured(): ApplicationException {
  return new ApplicationException(
    "route_geocoding_not_configured",
    "The Google Maps key is not set on the server (GOOGLE_MAPS_API_KEY).",
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
