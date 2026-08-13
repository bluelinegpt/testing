import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * §72: service-worker caching-policy assertions.
 *
 * `jsdom` (this project's test environment) does not implement
 * `ServiceWorkerGlobalScope`, so `sw.js` cannot be `importScripts`'d and
 * exercised directly the way a component test would. Instead this asserts
 * against the SOURCE, the same static-analysis idiom the codebase already
 * uses for its other "this must never contain X" guarantees
 * (`platform-security-certification.test.ts`'s "no destructive SQL
 * statement" scan) -- appropriate here because the property under test is
 * exactly "this file's code never mentions the forbidden paths", which a
 * source scan proves directly.
 */
describe("Service worker caching policy", () => {
  const swPath = resolve(import.meta.dirname, "../public/sw.js");
  const source = readFileSync(swPath, "utf8");

  it("only ever caches the static-asset prefixes, never anything else", () => {
    const match = /CACHEABLE_PREFIXES\s*=\s*(\[[^\]]*\])/.exec(source);
    expect(match).not.toBeNull();
    const prefixes = JSON.parse(match![1]!.replace(/'/g, '"')) as string[];
    expect(prefixes.sort()).toEqual(["/assets/", "/icons/"]);
  });

  it("never references /api/ anywhere in the cache-write path (§16/§17)", () => {
    expect(source.includes("/api/")).toBe(false);
  });

  it("never intercepts a non-GET request (no mutation replay, §27)", () => {
    expect(source).toMatch(/request\.method\s*!==\s*["']GET["']/);
  });

  it("only ever deletes its OWN versioned cache names on activate (§18)", () => {
    expect(source).toMatch(/key\.startsWith\(["']blueline-store-static-["']\)/);
  });

  it("registers no push event listener (§38: no provider wiring yet)", () => {
    expect(source.includes('addEventListener("push"')).toBe(false);
  });
});
