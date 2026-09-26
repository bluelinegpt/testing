import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lookupByAirwayBill,
  verifyAmbiguousShipment,
  TrackingRequestError,
} from "./tracking-client";

function mockFetchOnce(status: number, body: unknown) {
  const response = { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
}

describe("tracking-client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the Airway Bill and language to the lookup endpoint and returns a verified result", async () => {
    mockFetchOnce(200, {
      result: "verified",
      tracking: {
        airwayBill: "X123456",
        status: "delivered",
        statusLabel: "Delivered",
        lastUpdated: "2026-01-01T00:00:00Z",
        deliveredAt: "2026-01-01T00:00:00Z",
        timeline: [],
      },
    });
    const outcome = await lookupByAirwayBill("X123456", "en");
    expect(outcome.result).toBe("verified");
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("/public/tracking/lookup");
    expect(JSON.parse(call[1].body)).toEqual({ airwayBill: "X123456", language: "en" });
  });

  it("returns verification_required with an opaque token, never candidate data", async () => {
    mockFetchOnce(200, { result: "verification_required", verificationToken: "abc.def" });
    const outcome = await lookupByAirwayBill("X123456", "en");
    expect(outcome).toEqual({ result: "verification_required", verificationToken: "abc.def" });
  });

  it("posts the verification token, mobile and language to the verify endpoint", async () => {
    mockFetchOnce(200, { result: "not_verified" });
    const outcome = await verifyAmbiguousShipment("abc.def", "0501234567", "ar");
    expect(outcome).toEqual({ result: "not_verified" });
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("/public/tracking/verify");
    expect(JSON.parse(call[1].body)).toEqual({
      verificationToken: "abc.def",
      mobile: "0501234567",
      language: "ar",
    });
  });

  it("throws a friendly rate-limit message on 429", async () => {
    mockFetchOnce(429, {});
    await expect(lookupByAirwayBill("X123456", "en")).rejects.toThrow(TrackingRequestError);
    try {
      await lookupByAirwayBill("X123456", "en");
    } catch (error) {
      expect(error).toBeInstanceOf(TrackingRequestError);
      expect((error as TrackingRequestError).status).toBe(429);
    }
  });

  it("throws a generic message on server error, without leaking details", async () => {
    mockFetchOnce(500, { error: { message: "internal stack trace leak" } });
    try {
      await lookupByAirwayBill("X123456", "en");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TrackingRequestError);
      expect((error as TrackingRequestError).message).not.toContain("stack trace");
    }
  });
});
