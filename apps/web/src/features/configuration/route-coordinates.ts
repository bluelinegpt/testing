/**
 * Reads a latitude/longitude pair from what an administrator pastes:
 * "25.2048, 55.2708", a Google Maps place or pin link (`@25.2,55.3,17z`,
 * `!3d25.2!4d55.3`, `?q=25.2,55.3`, `query=25.2,55.3`, `ll=`), or a WhatsApp
 * location link that carries the same parameters. Short links (maps.app.goo.gl)
 * hide the position and cannot be read without opening them, so they return
 * null; the screen asks for the full link or the numbers instead.
 *
 * Parsing only -- nothing is fetched.
 */
export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;
const PAIR = new RegExp(String.raw`(${NUMBER})\s*,\s*(${NUMBER})`);

function valid(latitude: number, longitude: number): Coordinates | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)) };
}

export function parseCoordinates(input: string): Coordinates | null {
  const text = input.trim();
  if (text === "") return null;
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Keep the raw text when it is not valid URI encoding.
  }

  // A pin's exact position (!3d<lat>!4d<lng>) beats the map view centre (@).
  const pin = new RegExp(String.raw`!3d(${NUMBER})!4d(${NUMBER})`).exec(decoded);
  if (pin) return valid(Number(pin[1]), Number(pin[2]));
  const parameter = new RegExp(
    String.raw`[?&](?:q|query|ll|destination|center)=(${NUMBER})\s*,\s*(${NUMBER})`,
  ).exec(decoded);
  if (parameter) return valid(Number(parameter[1]), Number(parameter[2]));
  const at = new RegExp(String.raw`@(${NUMBER}),(${NUMBER})`).exec(decoded);
  if (at) return valid(Number(at[1]), Number(at[2]));
  if (/^https?:\/\//i.test(decoded)) return null;
  const plain = PAIR.exec(decoded);
  if (plain && plain.index === 0 && plain[0].length === decoded.replace(/\s+$/, "").length) {
    return valid(Number(plain[1]), Number(plain[2]));
  }
  return null;
}

/** A Google Maps link that shows a stored pin. */
export function mapsLinkFor(point: Coordinates): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.latitude},${point.longitude}`;
}

/** A Google Maps search for an Area by name, to find its centre once. */
export function mapsSearchFor(areaName: string, emirateName: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${areaName}, ${emirateName}, UAE`)}`;
}
