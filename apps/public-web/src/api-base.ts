const configuredApiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api/v1").replace(/\/$/, "");

export function apiBase(): string {
  return configuredApiBase;
}

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${configuredApiBase}${cleanPath}`;
}

export function publicAssetUrl(path: string | undefined | null): string {
  const cleanPath = String(path ?? "").trim();
  if (!cleanPath) return "";
  if (/^https?:\/\//i.test(cleanPath)) return cleanPath;
  if (cleanPath.startsWith("/api/")) return apiUrl(cleanPath.replace(/^\/api\/v1/, ""));
  return cleanPath;
}
