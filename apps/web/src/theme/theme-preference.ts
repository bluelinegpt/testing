export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "blueline.theme";

const themeValues = new Set<ThemePreference>(["light", "dark", "system"]);
const resolvedThemeValues = new Set<ResolvedTheme>(["light", "dark"]);

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && themeValues.has(value as ThemePreference);
}

export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return typeof value === "string" && resolvedThemeValues.has(value as ResolvedTheme);
}

export function resolveThemePreference(
  preference: ThemePreference,
  media: Pick<Window, "matchMedia"> | undefined = globalThis.window,
): ResolvedTheme {
  if (preference !== "system") return preference;
  return media?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readCachedResolvedTheme(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ResolvedTheme | undefined {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isResolvedTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedResolvedTheme(
  theme: ResolvedTheme,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme cache is best-effort; rendering still works without localStorage.
  }
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  documentRef: Pick<Document, "documentElement"> | undefined = globalThis.document,
): void {
  const root = documentRef?.documentElement;
  if (root === undefined) return;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveThemePreference(preference);
  applyResolvedTheme(resolved);
  writeCachedResolvedTheme(resolved);
  return resolved;
}

export function applyCachedThemeBeforePaint(): ResolvedTheme {
  const cached = readCachedResolvedTheme();
  const resolved = cached ?? resolveThemePreference("system");
  applyResolvedTheme(resolved);
  writeCachedResolvedTheme(resolved);
  return resolved;
}
