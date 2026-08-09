/**
 * The no-browser-storage rule, enforced against the source rather than against
 * behaviour.
 *
 * The behavioural test in `PlatformApp.test.tsx` proves that nothing lands in
 * storage on the paths it exercises. This one proves something stronger and
 * cheaper to keep true: the Portal contains no code that could write there on
 * ANY path, including ones no test has thought of yet.
 *
 * The source is read through Vite's own `import.meta.glob` rather than through
 * `node:fs`, so the test needs no Node type surface in an otherwise
 * browser-only project — and it reads exactly the files Vite would bundle,
 * which is the set that actually reaches a browser.
 *
 * Test files are excluded: they assert `localStorage.length === 0`, which is
 * the rule being kept, not a breach of it.
 */
const sources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

/**
 * Comments are stripped before scanning.
 *
 * This file's own subject matter has to be discussable: the API client explains
 * at length that it holds no token and has no `setAccessToken`, and the session
 * provider explains that nothing is written to `localStorage`. A scan that
 * could not tell code from prose would flag exactly the comments that document
 * the rule, and the only way to pass would be to delete the explanation.
 *
 * Block comments go entirely; line comments go only when they occupy the whole
 * line, which leaves `https://` and similar inside string literals untouched. A
 * trailing comment naming a forbidden token would still fail the scan — that is
 * a fair trade for not having to parse TypeScript here.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const applicationSources = Object.entries(sources)
  .filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
  .map(([path, contents]) => [path, withoutComments(contents)] as const);

const forbidden = ["localStorage", "sessionStorage", "indexedDB", "IndexedDB", "document.cookie"];

/**
 * The single exemption: the visual theme.
 *
 * The rule exists to keep CREDENTIALS out of script-readable storage — a token
 * there is retrievable by any injected script, which is why the session lives
 * in an HttpOnly cookie and why sign-in returns no token at all. A theme is not
 * a credential: it discloses nothing, grants nothing, and is worthless to an
 * attacker who already has script execution.
 *
 * It is exempted as ONE named file, not as a relaxed pattern, and the test
 * below bounds what that file may do. Adding a second entry is a deliberate,
 * visible edit to a security test.
 */
const storageExempt = ["theme/theme-preference.ts"];

describe("Platform Portal browser storage", () => {
  it("reads the application source", () => {
    expect(applicationSources.length).toBeGreaterThan(5);
  });

  it("contains no browser-storage or cookie access anywhere in the application source", () => {
    const offenders: string[] = [];
    for (const [path, contents] of applicationSources) {
      if (storageExempt.some((name) => path.endsWith(name))) continue;
      for (const token of forbidden) {
        if (contents.includes(token)) offenders.push(`${path}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The exemption is bounded, not trusted. The theme module may touch one key
   * and may not name anything credential-shaped; otherwise "the theme module is
   * exempt" quietly becomes "one file may store anything".
   */
  it("lets the theme module store the theme and nothing else", () => {
    const theme = applicationSources.find(([path]) =>
      path.endsWith("theme/theme-preference.ts"),
    )?.[1];
    expect(theme).toBeDefined();

    expect(theme).toContain('export const THEME_STORAGE_KEY = "blueline.platform.theme"');
    for (const use of theme?.match(/(getItem|setItem|removeItem)\(([^,)]+)/g) ?? []) {
      expect(use).toContain("THEME_STORAGE_KEY");
    }
    // localStorage only; no other storage surface.
    for (const token of ["sessionStorage", "indexedDB", "IndexedDB", "document.cookie"]) {
      expect(theme).not.toContain(token);
    }
    for (const token of ["token", "session", "password", "secret", "cookie", "auth"]) {
      expect(theme?.toLowerCase()).not.toContain(token);
    }
  });

  it("keeps the storage exemption to the single theme module", () => {
    expect(storageExempt).toEqual(["theme/theme-preference.ts"]);
  });

  it("exposes no way to set an access token on the API client", () => {
    const client = applicationSources.find(([path]) =>
      path.endsWith("api/platform-client.ts"),
    )?.[1];
    expect(client).toBeDefined();
    expect(client).not.toContain("setAccessToken");
    expect(client).not.toContain("Authorization");
    expect(client).toContain('credentials: "include"');
    expect(client).toContain('"X-Blueline-Session": "cookie"');
  });
});
