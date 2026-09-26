import type { ApiClient } from "./api-client.js";

/**
 * Where every error boundary in this app sends a crash report.
 *
 * A module-level singleton, not a React context: `ApplicationErrorBoundary`
 * is rendered by React Router as an `errorElement` at the router root, with
 * no props and no access to the app's `api` instance the normal component
 * tree has. `App.tsx` registers its `ApiClient` here once, immediately after
 * creating it; the SAME instance is used for every request the app makes, so
 * whatever access token is set on it at the moment a crash happens is what
 * this reports with -- no re-registration needed when the session changes.
 *
 * Deliberately never throws: reporting a crash must never cause a second
 * crash. If the client isn't registered yet, or the report itself fails
 * (network down, API also down), this silently does nothing.
 */
let client: ApiClient | undefined;

export function registerErrorReportingClient(api: ApiClient): void {
  client = api;
}

export function reportClientError(input: {
  readonly message: string;
  readonly stack?: string;
  readonly path?: string;
}): void {
  if (client === undefined) return;
  void client
    .post("errors", {
      appCommit: __APP_VERSION__,
      message: input.message,
      path: input.path ?? window.location.pathname,
      sourceApp: "web",
      stack: input.stack,
    })
    .catch(() => {
      // Reporting a crash must never itself throw.
    });
}

// Baked in by vite.config.ts's `define` -- see VersionBadge for the same
// contract.
declare const __APP_VERSION__: string;
