import { apiBase } from "./api-base";

// Mirrors the API's PublicTrackingService response contract exactly (see
// apps/api/src/operations/public-tracking.service.ts) -- the Homepage widget
// and the /track page both call these same two functions, never a second
// tracking implementation.
export interface PublicTrackingTimelineStep {
  status: string;
  statusLabel: string;
  occurredAt: string;
}
export interface PublicTrackingResult {
  airwayBill: string;
  status: string;
  statusLabel: string;
  lastUpdated: string;
  deliveredAt: string | null;
  timeline: PublicTrackingTimelineStep[];
}
export type TrackingLookupOutcome =
  | { result: "verified"; tracking: PublicTrackingResult }
  | { result: "verification_required"; verificationToken: string }
  | { result: "not_found" };
export type TrackingVerifyOutcome =
  | { result: "verified"; tracking: PublicTrackingResult }
  | { result: "not_verified" }
  | { result: "ambiguous" };

export class TrackingRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message =
      response.status === 429
        ? "You've tried a few times. Please wait a moment and try again."
        : response.status >= 500
          ? "We couldn't check tracking right now. Please try again."
          : "Please check the details and try again.";
    throw new TrackingRequestError(message, response.status);
  }
  return (await response.json()) as T;
}

export function lookupByAirwayBill(
  airwayBill: string,
  language: "en" | "ar",
): Promise<TrackingLookupOutcome> {
  return post("/public/tracking/lookup", { airwayBill, language });
}

export function verifyAmbiguousShipment(
  verificationToken: string,
  mobile: string,
  language: "en" | "ar",
): Promise<TrackingVerifyOutcome> {
  return post("/public/tracking/verify", { verificationToken, mobile, language });
}
