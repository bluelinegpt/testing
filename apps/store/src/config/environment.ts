/**
 * Store application configuration.
 *
 * ---------------------------------------------------------------------------
 * NO HOSTNAME IS WRITTEN INTO A COMPONENT
 * ---------------------------------------------------------------------------
 *
 * `store.bluelinegpt.com` appears nowhere in this application's source. Every
 * environment — local, stage, production — supplies its own values, and the
 * defaults below are the LOCAL ones, because a default that silently points at
 * production is a defect waiting for a misconfigured deploy.
 *
 * `apiBaseUrl` defaults to a relative `/api/v1`. That is deliberate and is the
 * single most important line in this file: a relative base means the browser
 * talks to the Store's own origin, and the dev server proxies it to the API.
 * An absolute `http://localhost:3000` would make every future customer session
 * cross-site, and the browser would withhold a SameSite=Lax cookie — the exact
 * defect the Delivery Portal already had to fix once.
 *
 * Nothing secret belongs here. Everything in this object reaches the browser.
 */
export interface StoreConfiguration {
  readonly apiBaseUrl: string;
  readonly defaultLanguage: "ar" | "en";
  readonly features: {
    readonly marketplaceHomeEnabled: boolean;
    readonly storePublicEnabled: boolean;
  };
  readonly siteName: string;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

const environment = import.meta.env as Record<string, string | undefined>;

export const storeConfiguration: StoreConfiguration = {
  apiBaseUrl: environment.VITE_API_BASE_URL ?? "/api/v1",
  defaultLanguage: environment.VITE_DEFAULT_LANGUAGE === "ar" ? "ar" : "en",
  features: {
    // A disabled marketplace must never disable Delivery operations — these
    // flags are read only by this application and nothing else consults them.
    marketplaceHomeEnabled: flag(environment.VITE_MARKETPLACE_HOME_ENABLED, true),
    storePublicEnabled: flag(environment.VITE_STORE_PUBLIC_ENABLED, true),
  },
  siteName: environment.VITE_STORE_SITE_NAME ?? "TawseelHub Store",
};
