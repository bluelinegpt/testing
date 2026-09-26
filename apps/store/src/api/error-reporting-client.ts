import { storeConfiguration } from "../config/environment.js";

/**
 * Where the Store's error boundary reports a crash.
 *
 * Always the PUBLIC endpoint (`/errors/public`), never the authenticated
 * one: the Store serves anonymous shoppers who may never have signed in, so
 * a crash can happen before there is any session to attach. See
 * `ClientErrorReportController`'s own comment for the full reasoning.
 *
 * Deliberately never throws -- reporting a crash must never cause a second
 * crash.
 */
export function reportClientError(input: {
  readonly message: string;
  readonly stack?: string;
  readonly path?: string;
}): void {
  void fetch(`${storeConfiguration.apiBaseUrl}/errors/public`, {
    body: JSON.stringify({
      appCommit: __APP_VERSION__,
      message: input.message,
      path: input.path ?? window.location.pathname,
      sourceApp: "store",
      stack: input.stack,
    }),
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => {
    // See doc comment above.
  });
}

// Baked in by vite.config.ts's `define`.
declare const __APP_VERSION__: string;
