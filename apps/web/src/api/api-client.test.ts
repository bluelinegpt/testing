import { afterEach, vi } from "vitest";

vi.mock("../configuration/environment.js", () => ({
  webConfiguration: { apiBaseUrl: "https://api.blueline.test/api/v1" },
}));

import { ApiClient } from "./api-client.js";

describe("ApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns successful JSON responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json; charset=utf-8" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ApiClient().get<{ status: string }>("health/live")).resolves.toEqual({
      status: "ok",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.blueline.test/api/v1/health/live",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects successful responses that are not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("upstream HTML", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
      ),
    );

    await expect(new ApiClient().get("health/live")).rejects.toThrow("unsupported content type");
  });

  it("aborts requests after the configured timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, request: RequestInit) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              reject(new DOMException("Request aborted", "AbortError"));
            });
          }),
      ),
    );

    const response = new ApiClient(25).get("health/live");
    const expectation = expect(response).rejects.toMatchObject({
      code: "request_timeout",
      message: "The request timed out. Please try again.",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => new ApiClient(0)).toThrow("positive integer");
  });
});
