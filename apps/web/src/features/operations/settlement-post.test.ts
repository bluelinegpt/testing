import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../api/api-client.js";
import { confirmDraftSafely, isUncertainOutcome } from "./settlement-post.js";

const timeout = () =>
  new ApiError("The request timed out. Please try again.", "request_timeout", 408);
const noWait = () => Promise.resolve();

describe("confirmDraftSafely (SET-PERF-1)", () => {
  it("returns the post when the server answers", async () => {
    const api = { get: vi.fn(), postLong: vi.fn().mockResolvedValue({ settlementId: "s-1" }) };
    const onChecking = vi.fn();
    await expect(confirmDraftSafely(api, "d-1", onChecking)).resolves.toEqual({
      outcome: "posted",
      result: { settlementId: "s-1" },
    });
    expect(onChecking).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("on a lost answer, finds the draft posted and reads back that same post", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ status: "confirmed" }),
      postLong: vi
        .fn()
        .mockRejectedValueOnce(timeout())
        .mockResolvedValueOnce({ settlementId: "s-1" }),
    };
    const onChecking = vi.fn();
    await expect(confirmDraftSafely(api, "d-1", onChecking, { wait: noWait })).resolves.toEqual({
      outcome: "posted",
      result: { settlementId: "s-1" },
    });
    expect(onChecking).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledWith("operations/settlements/drafts/d-1");
  });

  it("waits while the first request may still be running, then reports the post", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ status: "draft" })
        .mockResolvedValueOnce({ status: "confirmed" }),
      postLong: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ settlementId: "s-1" }),
    };
    const wait = vi.fn(noWait);
    await expect(confirmDraftSafely(api, "d-1", vi.fn(), { wait })).resolves.toMatchObject({
      outcome: "posted",
    });
    expect(wait).toHaveBeenCalledOnce();
  });

  it("reports not posted when the draft stays a draft", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ status: "draft" }),
      postLong: vi.fn().mockRejectedValue(timeout()),
    };
    await expect(
      confirmDraftSafely(api, "d-1", vi.fn(), { attempts: 3, wait: noWait }),
    ).resolves.toEqual({
      outcome: "not_posted",
    });
    expect(api.postLong).toHaveBeenCalledOnce();
  });

  it("reports unknown when the server cannot be reached to check", async () => {
    const api = {
      get: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      postLong: vi.fn().mockRejectedValue(timeout()),
    };
    await expect(
      confirmDraftSafely(api, "d-1", vi.fn(), { attempts: 2, wait: noWait }),
    ).resolves.toEqual({
      outcome: "unknown",
    });
  });

  it("passes a real refusal straight through (no checking)", async () => {
    const refusal = new ApiError("Not allowed", "balance_would_go_negative", 409);
    const api = { get: vi.fn(), postLong: vi.fn().mockRejectedValue(refusal) };
    await expect(confirmDraftSafely(api, "d-1", vi.fn())).rejects.toBe(refusal);
    expect(api.get).not.toHaveBeenCalled();
  });

  it("treats timeouts, dropped connections and gateway errors as uncertain, and nothing else", () => {
    expect(isUncertainOutcome(timeout())).toBe(true);
    expect(isUncertainOutcome(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUncertainOutcome(new ApiError("Bad gateway", "request_failed", 502))).toBe(true);
    expect(isUncertainOutcome(new ApiError("Conflict", "x", 409))).toBe(false);
    expect(isUncertainOutcome(new Error("boom"))).toBe(false);
  });
});
