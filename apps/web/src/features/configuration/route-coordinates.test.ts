import { describe, expect, it } from "vitest";

import { mapsLinkFor, mapsSearchFor, parseCoordinates } from "./route-coordinates.js";

describe("parseCoordinates", () => {
  it("reads a typed pair", () => {
    expect(parseCoordinates("25.2048, 55.2708")).toEqual({ latitude: 25.2048, longitude: 55.2708 });
    expect(parseCoordinates("25.2048,55.2708 ")).toEqual({ latitude: 25.2048, longitude: 55.2708 });
  });

  it("reads Google Maps links, preferring the pin over the map centre", () => {
    expect(
      parseCoordinates(
        "https://www.google.com/maps/place/Al+Majaz/@25.3201,55.3800,15z/data=!3m1!4b1!3d25.3262!4d55.3834",
      ),
    ).toEqual({ latitude: 25.3262, longitude: 55.3834 });
    expect(parseCoordinates("https://www.google.com/maps/@25.3201,55.38,15z")).toEqual({
      latitude: 25.3201,
      longitude: 55.38,
    });
    expect(parseCoordinates("https://maps.google.com/?q=25.27,55.38")).toEqual({
      latitude: 25.27,
      longitude: 55.38,
    });
    expect(
      parseCoordinates("https://www.google.com/maps/search/?api=1&query=25.27%2C55.38"),
    ).toEqual({
      latitude: 25.27,
      longitude: 55.38,
    });
  });

  it("rejects short links, out-of-range values and free text", () => {
    expect(parseCoordinates("https://maps.app.goo.gl/AbCdEf123")).toBeNull();
    expect(parseCoordinates("95, 55")).toBeNull();
    expect(parseCoordinates("Al Majaz, Sharjah")).toBeNull();
    expect(parseCoordinates("25.2 55.3 extra")).toBeNull();
    expect(parseCoordinates("")).toBeNull();
  });

  it("builds map links", () => {
    expect(mapsLinkFor({ latitude: 25.27, longitude: 55.38 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=25.27,55.38",
    );
    expect(mapsSearchFor("Al Majaz", "Sharjah")).toContain("Al%20Majaz%2C%20Sharjah%2C%20UAE");
  });
});
