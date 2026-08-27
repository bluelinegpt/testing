const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function hostnameOf(host) {
  if (typeof host !== "string") return undefined;
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .split(":")[0];
  return value || undefined;
}

export function classifyCompanyAppHost(host, configuredSuffix) {
  const hostname = hostnameOf(host);
  const suffix = configuredSuffix?.trim().toLowerCase().replace(/^\.+/u, "");
  if (hostname === undefined) return "rejected";
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "local";
  if (!suffix) return "unrestricted";
  if (!hostname.endsWith(`.${suffix}`)) return "rejected";
  const label = hostname.slice(0, -(suffix.length + 1));
  if (label.includes(".") || !label.endsWith("app")) return "rejected";
  const companySlug = label.slice(0, -3);
  return dnsLabelPattern.test(companySlug) ? "company-app" : "rejected";
}

export function parseLegacyTenantRedirects(value) {
  const redirects = new Map();
  for (const entry of (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator < 1)
      throw new Error("WEB_LEGACY_TENANT_REDIRECTS entries must be host=https://host");
    const source = hostnameOf(entry.slice(0, separator));
    const target = new URL(entry.slice(separator + 1));
    if (source === undefined || target.protocol !== "https:" || target.pathname !== "/") {
      throw new Error("WEB_LEGACY_TENANT_REDIRECTS entries must be host=https://host");
    }
    redirects.set(source, target.origin);
  }
  return redirects;
}
