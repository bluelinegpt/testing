import { afterEach, describe, expect, it, vi } from "vitest";

import { platformApi, platformApiErrorMessage } from "./platform-client.js";
afterEach(() => vi.unstubAllGlobals());

describe("Platform API user-facing errors", () => {
  it("sends import files as multipart with session and CSRF protection", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ fields: {}, warnings: [] }) });
    vi.stubGlobal("fetch", fetcher);
    await platformApi.importBlogArticle(new File(["Article body"], "article.txt"), "");
    const options = fetcher.mock.calls[0]![1];
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.credentials).toBe("include");
    expect(options.headers["X-Blueline-Session"]).toBe("cookie");
    expect(options.headers["Content-Type"]).toBeUndefined();
  });
  it("explains temporary proxy and service failures without claiming a save succeeded", () => {
    expect(platformApiErrorMessage(502, undefined)).toMatch(/could not reach.*not saved/iu);
    expect(platformApiErrorMessage(503, undefined)).toMatch(/temporarily unavailable.*not saved/iu);
  });

  it("gives a bounded retry instruction for rate limiting", () => {
    expect(platformApiErrorMessage(429, undefined)).toMatch(/wait one minute/iu);
  });

  it("preserves safe business validation messages", () => {
    expect(platformApiErrorMessage(422, "Website slug is invalid")).toBe("Website slug is invalid");
  });
});
