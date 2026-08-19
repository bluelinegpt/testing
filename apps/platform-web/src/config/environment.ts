export interface PlatformConfiguration {
  readonly apiBaseUrl: string;
  readonly publicWebBaseUrl: string;
  readonly siteName: string;
}

/**
 * Platform Portal configuration.
 *
 * `platform.bluelinegpt.com` appears nowhere in this application's source. Each
 * environment supplies its own values and the defaults below are the LOCAL
 * ones, because a default that silently points at production is a defect
 * waiting for a misconfigured deploy.
 *
 * `apiBaseUrl` defaults to the relative `/api/v1`, and that default matters
 * more here than anywhere else in the repository: the Platform session is an
 * HttpOnly `SameSite=Lax` cookie with no bearer-token fallback of any kind. An
 * absolute API origin would make every request cross-site, the browser would
 * withhold the cookie, and the Portal would be permanently signed out with no
 * way to recover — there is no token in JavaScript to fall back on. Same-origin
 * is not a preference; it is the only shape that works.
 *
 * Nothing secret belongs here. Everything in this object reaches the browser.
 */
const environment = import.meta.env as Record<string, string | undefined>;

function validateBase(value: string | undefined): string {
  const trimmed = (value ?? "/api/v1").trim();
  if (trimmed.startsWith("/")) return trimmed.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("VITE_API_BASE_URL must use HTTP or HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

export const platformConfiguration: PlatformConfiguration = {
  apiBaseUrl: validateBase(environment.VITE_API_BASE_URL),
  publicWebBaseUrl: validateBase(environment.VITE_PUBLIC_WEB_BASE_URL ?? "http://localhost:5174"),
  siteName: environment.VITE_PLATFORM_SITE_NAME ?? "TawseelHub Platform Administration",
};
