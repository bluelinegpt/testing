import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * §71: manifest validation -- required fields, scope/start_url, approved
 * colour tokens only, parseable icon declarations.
 */
describe("Web App Manifest", () => {
  const manifestPath = resolve(import.meta.dirname, "../public/manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

  it("is valid, parseable JSON with the required identity fields", () => {
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name).toBe("BluelineGPT Store");
    expect(typeof manifest.short_name).toBe("string");
    expect(manifest.display).toBe("standalone");
  });

  it("uses a stable, safe start_url and scope (§9/§10)", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    // Never a hard-coded development Store slug.
    expect(String(manifest.start_url)).not.toMatch(/dev-commerce-store/);
  });

  it("uses only the approved Store colour tokens (§8)", () => {
    expect(manifest.theme_color).toBe("#101936");
    expect(manifest.background_color).toBe("#f4f7fb");
  });

  it("declares parseable icons with real dimensions", () => {
    const icons = manifest.icons as { src: string; sizes: string; type: string }[];
    expect(Array.isArray(icons)).toBe(true);
    expect(icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of icons) {
      expect(icon.src.startsWith("/icons/")).toBe(true);
      expect(icon.sizes).toMatch(/^\d+x\d+$/);
      expect(icon.type).toBe("image/png");
    }
  });

  it("never falsely declares a maskable icon without safe-zone-verified artwork (§12)", () => {
    const icons = manifest.icons as { purpose?: string }[];
    for (const icon of icons) {
      expect(icon.purpose === undefined || icon.purpose === "any").toBe(true);
    }
  });
});
