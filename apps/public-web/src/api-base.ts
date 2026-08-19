const configuredApiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api/v1").replace(/\/$/, "");

export function apiBase(): string {
  return configuredApiBase;
}

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${configuredApiBase}${cleanPath}`;
}
