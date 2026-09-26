import { apiUrl } from "./api-base";

/**
 * Where the public marketing site reports an unexpected browser crash.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN (Error Handler follow-up prompt)
 * ---------------------------------------------------------------------------
 *
 * This previously sent `{ message, stack, url, app }` to `/errors/public`.
 * Two things made every one of those reports silently fail: `app` is not a
 * field `ReportClientErrorDto` recognises (the field is `sourceApp`), and
 * `'public-web'` was not yet an allowed `source_app` value at all — both the
 * DTO's `@IsIn` list and the database's own CHECK constraint rejected it.
 * With the global `ValidationPipe({ forbidNonWhitelisted: true })`, every
 * post from this file has always come back 400 and been swallowed by its own
 * `catch` — this app's crash reporting has never actually worked. Both gaps
 * are now closed (`20260921000000_client_error_reports_public_web.ts`,
 * `ReportClientErrorDto`), and this file now sends the shape the DTO
 * actually accepts, matching the pattern `apps/store`'s
 * `error-reporting-client.ts` already established.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * `window.onerror`/`unhandledrejection` fire for unexpected runtime crashes
 * only — this is never wired into the site's own form/quote validation,
 * which already returns its own inline messages and never reaches these
 * listeners. No correlation id is attached: a bare browser crash has no
 * in-flight API request to correlate with, and inventing one would be worse
 * than omitting it. `location.pathname` is sent as `path`, never the full
 * URL — a query string can carry a quote/demo form's answers, and the DTO
 * has no field meant to hold that.
 */
interface ErrorReportInput {
  readonly message: string;
  readonly stack: string | undefined;
}

function report(input: ErrorReportInput): void {
  void fetch(apiUrl("/errors/public"), {
    body: JSON.stringify({
      appCommit: __APP_VERSION__,
      message: input.message,
      path: window.location.pathname,
      sourceApp: "public-web",
      stack: input.stack,
    }),
    credentials: "omit",
    headers: { "content-type": "application/json" },
    keepalive: true,
    method: "POST",
  }).catch(() => {
    // Reporting a crash must never cause a second crash.
  });
}

export function installCrashReporting(): void {
  window.addEventListener("error", (event) => {
    report({
      message: event.message || "Uncaught client error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    report({
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

// Baked in by vite.config.ts's `define`, same pattern as the version badge.
declare const __APP_VERSION__: string;
