export interface WebConfiguration {
  readonly apiBaseUrl: string;
}

/**
 * The API base, absolute or same-origin.
 *
 * A SAME-ORIGIN value (a path such as `/api/v1`) is now supported and is the
 * preferred deployment shape, because the session cookie is `SameSite=Lax`:
 * on a cross-site request the browser withholds it, and the user is signed out
 * on every reload again. Serving the API under the web origin — via the dev
 * proxy below or a reverse proxy in production — makes the cookie first-party
 * and removes that whole class of problem.
 *
 * An absolute URL remains valid for callers that authenticate with a bearer
 * token rather than the cookie.
 */
function validateUrl(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) return trimmed.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export const webConfiguration: WebConfiguration = {
  apiBaseUrl: validateUrl(import.meta.env.VITE_API_BASE_URL, "VITE_API_BASE_URL"),
};
