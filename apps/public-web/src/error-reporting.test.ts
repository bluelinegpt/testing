// @vitest-environment jsdom
// This package's default vitest environment is `node` (no `window`) --
// `installCrashReporting()` needs real `window`/`Event`/`ErrorEvent`
// globals, which only jsdom provides.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { installCrashReporting } from "./error-reporting";

/**
 * Error Handler follow-up prompt, §10: proves `public-web`'s crash reporter
 * now sends the shape `ReportClientErrorDto` actually accepts (§4), not the
 * `{message, stack, url, app}` shape that always failed validation before
 * this fix.
 *
 * `installCrashReporting()` is called exactly ONCE (`beforeAll`), not once
 * per test: it registers `window` listeners with no matching uninstall, so
 * calling it per-test would stack N listeners by the Nth test and each
 * dispatched event would report N times. `fetch` is re-stubbed per test
 * instead, which the installed listeners pick up at call time regardless of
 * when they were registered.
 */
describe("public-web crash reporting", () => {
  beforeAll(() => {
    installCrashReporting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reports an uncaught window error with the correct DTO shape", () => {
    const fetchMock = stubFetch();

    const error = new Error("boom");
    window.dispatchEvent(
      Object.assign(new Event("error"), { error, message: error.message }) as ErrorEvent,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/errors/public");
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body.sourceApp).toBe("public-web");
    expect(body.message).toBe("boom");
    expect(typeof body.stack).toBe("string");
    expect(typeof body.path).toBe("string");
    expect(typeof body.appCommit).toBe("string");
    // The old, always-rejected shape must not reappear.
    expect(body).not.toHaveProperty("app");
    expect(body).not.toHaveProperty("url");
    expect((init as RequestInit).credentials).toBe("omit");
  });

  it("reports an unhandled promise rejection with the correct DTO shape", () => {
    const fetchMock = stubFetch();

    const rejectionEvent = Object.assign(new Event("unhandledrejection"), {
      promise: Promise.reject(new Error("async boom")).catch(() => undefined),
      reason: new Error("async boom"),
    });
    window.dispatchEvent(rejectionEvent as unknown as PromiseRejectionEvent);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.sourceApp).toBe("public-web");
    expect(body.message).toBe("async boom");
    expect(body).not.toHaveProperty("app");
    expect(body).not.toHaveProperty("url");
  });

  it("stringifies a non-Error rejection reason rather than sending stack for it", () => {
    const fetchMock = stubFetch();

    const rejectionEvent = Object.assign(new Event("unhandledrejection"), {
      promise: Promise.reject("plain string reason").catch(() => undefined),
      reason: "plain string reason",
    });
    window.dispatchEvent(rejectionEvent as unknown as PromiseRejectionEvent);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.message).toBe("plain string reason");
    expect(body.stack).toBeUndefined();
  });

  it("never throws when the report request itself fails", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(() => {
      window.dispatchEvent(
        Object.assign(new Event("error"), { error: new Error("x"), message: "x" }) as ErrorEvent,
      );
    }).not.toThrow();
  });
});
