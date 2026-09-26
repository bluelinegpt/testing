import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "../../database/migrations/20260971000000_localize_arabic_help_canonicals.ts",
);
const migrationSource = readFileSync(migrationPath, "utf8");

function revisedCanonicalPattern(): RegExp {
  const match = migrationSource.match(
    /canonical_path ~ '(\^\/\(ar\/\)\?resources\/\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$)'/,
  );
  if (match?.[1] === undefined) {
    throw new Error("The bilingual Help canonical CHECK pattern was not found in the migration.");
  }
  return new RegExp(match[1]);
}

describe("Arabic Help canonical migration", () => {
  it("replaces the old CHECK before localizing Arabic rows", () => {
    const upSource = migrationSource.slice(
      migrationSource.indexOf("export async function up"),
      migrationSource.indexOf("export async function down"),
    );

    const dropConstraint = upSource.indexOf(
      "drop constraint platform_help_articles_canonical_path_check",
    );
    const addConstraint = upSource.indexOf(
      "add constraint platform_help_articles_canonical_path_check",
    );
    const updateRows = upSource.indexOf("update platform_help_articles");

    expect(dropConstraint).toBeGreaterThan(-1);
    expect(addConstraint).toBeGreaterThan(dropConstraint);
    expect(updateRows).toBeGreaterThan(addConstraint);
  });

  it.each(["/resources/what-is-tawseelhub", "/ar/resources/what-is-tawseelhub"])(
    "accepts the intended canonical %s",
    (path) => {
      expect(revisedCanonicalPattern().test(path)).toBe(true);
    },
  );

  it.each([
    "https://tawseelhub.com/resources/what-is-tawseelhub",
    "/blog/what-is-tawseelhub",
    "/admin/resources/what-is-tawseelhub",
    "/resources/",
    "/resources/What_Is_Tawseelhub",
    "/ar/resources/what-is-tawseelhub/extra",
    "/pricing/what-is-tawseelhub",
  ])("rejects invalid or unrelated canonical %s", (path) => {
    expect(revisedCanonicalPattern().test(path)).toBe(false);
  });

  it("preserves English rows and localizes only legacy Arabic canonicals", () => {
    expect(migrationSource).toContain("where locale = 'ar'");
    expect(migrationSource).toContain("and canonical_path = '/resources/' || slug");
    expect(migrationSource).toContain("canonical_path = '/ar/resources/' || slug");
  });
});
