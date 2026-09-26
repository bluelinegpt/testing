/**
 * Theme preference for the Platform Portal.
 *
 * Mirrors `apps/web/src/theme/theme-preference.ts` deliberately: the same three
 * choices, the same `data-theme` attribute on the document element, the same
 * `color-scheme` hint, and the same pre-paint application. An administrator who
 * uses both portals should not have to learn two different controls.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE ONLY BROWSER STORAGE IN THE PLATFORM PORTAL
 * ---------------------------------------------------------------------------
 *
 * The Portal otherwise stores nothing in the browser at all, and a
 * certification test enforces that. The rule exists because a CREDENTIAL in
 * script-readable storage is retrievable by any injected script — which is
 * exactly why the session lives in an HttpOnly cookie and why sign-in returns
 * no token.
 *
 * A theme is not a credential. It discloses nothing, grants nothing, and is
 * worthless to an attacker who already has script execution. So this module is
 * the single, named exception: it reads and writes ONE key holding ONE of three
 * literal words, and the certification test asserts both that nothing else in
 * the app touches storage and that this module stores nothing but the theme.
 *
 * The Company Portal persists its preference server-side as well, via
 * `me/preferences/theme`. That route is `@RequireIdentityKinds("company_user")`
 * and writes against a `company_users` row, so a Platform Administrator —
 * whose `company_id` is null by constraint — cannot use it. Reaching parity
 * that way would mean a new Platform API surface and somewhere to store it;
 * that is a larger decision than a visual preference warrants today.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREFERENCE IS STORED, NOT THE RESOLVED THEME
 * ---------------------------------------------------------------------------
 *
 * `apps/web` caches the RESOLVED theme, because the server holds the
 * preference and the cache exists only to avoid a flash before that arrives.
 * Here there is no server copy, so storing "dark" would lose the difference
 * between "this administrator chose dark" and "their OS is currently dark" —
 * and System would stop following the OS after the first visit. The preference
 * is stored; the resolution happens on every load.
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** The one and only key this application writes to browser storage. */
export const THEME_STORAGE_KEY = "blueline.platform.theme";

const themeValues = new Set<ThemePreference>(["light", "dark", "system"]);

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && themeValues.has(value as ThemePreference);
}

export function resolveThemePreference(
  preference: ThemePreference,
  media: Pick<Window, "matchMedia"> | undefined = globalThis.window,
): ResolvedTheme {
  if (preference !== "system") return preference;
  // `matchMedia` is missing in jsdom and in any non-browser host, and a missing
  // media query is not a dark one.
  return media?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readStoredPreference(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    // Defaults to "light" rather than "system": a Platform Administrator's OS
    // dark-mode setting should not decide the first look of an internal admin
    // tool nobody has configured yet. An explicit choice — including
    // explicitly picking "System" from the theme control — is still honoured
    // exactly as before; this only changes what an administrator who has
    // never touched the control sees.
    return isThemePreference(value) ? value : "light";
  } catch {
    // Storage can throw outright: private browsing, a disabled-cookies policy,
    // a full quota. A theme must never be the reason the Portal fails to load.
    return "light";
  }
}

export function writeStoredPreference(
  preference: ThemePreference,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Best effort. The choice still applies for this session.
  }
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  documentRef: Pick<Document, "documentElement"> | undefined = globalThis.document,
): void {
  const root = documentRef?.documentElement;
  if (root === undefined || root === null) return;
  root.dataset.theme = theme;
  // Tells the browser to render its own widgets — scrollbars, form controls,
  // the autofill overlay — to match. Without it a dark page keeps a white
  // scrollbar and light-on-light autofilled inputs.
  root.style.colorScheme = theme;
}

/** Applies a preference, stores it, and reports what it resolved to. */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveThemePreference(preference);
  applyResolvedTheme(resolved);
  writeStoredPreference(preference);
  return resolved;
}

/**
 * Applies the stored preference before React renders anything.
 *
 * Imported for its side effect from `main.tsx`, ahead of the application, so
 * the correct palette is on the document element before the first paint. Doing
 * it inside a component would show every administrator a flash of the wrong
 * theme on every load.
 */
export function applyStoredThemeBeforePaint(): ResolvedTheme {
  const preference = readStoredPreference();
  const resolved = resolveThemePreference(preference);
  applyResolvedTheme(resolved);
  return resolved;
}
