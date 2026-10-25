import type { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";
import {
  AreaGeocoder,
  type FetchLike,
  geocodeQuery,
  GeocoderQuotaReached,
  insideEmirate,
  suggestionFlag,
} from "./area-geocoder.js";

function configWith(key: string | undefined): ConfigService<AppConfiguration, true> {
  return {
    get: () => ({ googleMapsApiKey: key }),
  } as unknown as ConfigService<AppConfiguration, true>;
}

function fetchReturning(body: unknown, status = 200): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) }));
}

const found = (lat: number, lng: number, types: string[], partial = false) => ({
  status: "OK",
  results: [
    {
      formatted_address: "Somewhere - Dubai - United Arab Emirates",
      types,
      partial_match: partial,
      geometry: { location: { lat, lng } },
    },
  ],
});

describe("Area pin suggestions from Google", () => {
  it("asks for the Area in its city, in the UAE", () => {
    expect(
      geocodeQuery({ nameEn: "Al Barsha 1", nameAr: null, emirateCode: "DXB", emirateNameEn: "Dubai" }),
    ).toBe("Al Barsha 1, Dubai, United Arab Emirates");
    expect(
      geocodeQuery({ nameEn: "Al Jimi", nameAr: null, emirateCode: "AAN", emirateNameEn: "AL Ain" }),
    ).toBe("Al Jimi, Al Ain, United Arab Emirates");
    expect(
      geocodeQuery({ nameEn: " ", nameAr: "البدع", emirateCode: "EST", emirateNameEn: "Eastern Regions" }),
    ).toBe("البدع, United Arab Emirates");
  });

  it("knows the Emirates apart, exclaves included", () => {
    expect(insideEmirate("DXB", { latitude: 25.113, longitude: 55.2 })).toBe(true); // Al Barsha
    expect(insideEmirate("DXB", { latitude: 24.79, longitude: 56.12 })).toBe(true); // Hatta
    expect(insideEmirate("DXB", { latitude: 25.79, longitude: 55.95 })).toBe(false); // RAK
    expect(insideEmirate("AJM", { latitude: 25.405, longitude: 55.45 })).toBe(true);
    expect(insideEmirate("SHJ", { latitude: 25.34, longitude: 56.35 })).toBe(true); // Khor Fakkan
    expect(insideEmirate("EST", { latitude: 10, longitude: 10 })).toBe(true); // no box: not judged
  });

  it("flags anything an administrator must look at before it is used", () => {
    const outcome = (point: { latitude: number; longitude: number } | null, types: string[], partial = false) => ({
      point,
      formattedAddress: null,
      resultTypes: types,
      partialMatch: partial,
    });
    expect(suggestionFlag("DXB", outcome(null, []))).toBe("not_found");
    expect(suggestionFlag("DXB", outcome({ latitude: 25.36, longitude: 55.39 }, ["neighborhood"]))).toBe(
      null,
    );
    expect(suggestionFlag("DXB", outcome({ latitude: 25.79, longitude: 55.95 }, ["neighborhood"]))).toBe(
      "outside_emirate",
    );
    expect(
      suggestionFlag("DXB", outcome({ latitude: 25.2, longitude: 55.27 }, ["locality", "political"])),
    ).toBe("city_level");
    expect(
      suggestionFlag("DXB", outcome({ latitude: 25.2, longitude: 55.27 }, ["sublocality"], true)),
    ).toBe("partial_match");
  });

  it("reads Google's answer and never puts the key anywhere but the request", async () => {
    const fetcher = fetchReturning(found(25.1129381, 55.2003, ["neighborhood", "political"]));
    const geocoder = new AreaGeocoder(configWith("secret-key"), fetcher);
    expect(geocoder.configured).toBe(true);
    const result = await geocoder.geocode("Al Barsha 1, Dubai, United Arab Emirates");
    expect(result).toEqual({
      point: { latitude: 25.112938, longitude: 55.2003 },
      formattedAddress: "Somewhere - Dubai - United Arab Emirates",
      resultTypes: ["neighborhood", "political"],
      partialMatch: false,
    });
    const url = String(fetcher.mock.calls[0]?.[0]);
    expect(url).toContain("address=Al%20Barsha%201%2C%20Dubai");
    expect(url).toContain("components=country:AE");
    expect(url).toContain("key=secret-key");
  });

  it("treats no result as not found, a quota answer as stop, and a refusal as an error without detail", async () => {
    const empty = new AreaGeocoder(configWith("k"), fetchReturning({ status: "ZERO_RESULTS", results: [] }));
    expect((await empty.geocode("x")).point).toBeNull();
    const quota = new AreaGeocoder(configWith("k"), fetchReturning({ status: "OVER_QUERY_LIMIT" }));
    await expect(quota.geocode("x")).rejects.toBeInstanceOf(GeocoderQuotaReached);
    const throttled = new AreaGeocoder(configWith("k"), fetchReturning({}, 429));
    await expect(throttled.geocode("x")).rejects.toBeInstanceOf(GeocoderQuotaReached);
    const denied = new AreaGeocoder(
      configWith("k"),
      fetchReturning({ status: "REQUEST_DENIED", error_message: "The provided API key is invalid." }),
    );
    await expect(denied.geocode("x")).rejects.toMatchObject({ errorCode: "route_geocoding_denied" });
    const broken = new AreaGeocoder(configWith("k"), vi.fn(() =>
      Promise.reject(new Error("fetch failed https://maps.googleapis.com/...&key=k")),
    ));
    const error = await broken.geocode("x").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ errorCode: "route_geocoding_unreachable" });
    expect(String((error as Error).message)).not.toContain("key=");
  });

  it("refuses to look anything up without a key", async () => {
    const geocoder = new AreaGeocoder(configWith(undefined), fetchReturning({}));
    expect(geocoder.configured).toBe(false);
    await expect(geocoder.geocode("x")).rejects.toMatchObject({
      errorCode: "route_geocoding_not_configured",
    });
  });
});
