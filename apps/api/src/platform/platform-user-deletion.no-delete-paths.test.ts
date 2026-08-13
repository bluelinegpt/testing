import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A permanent regression guard, not gated on a live database: the one thing
 * that makes the `company_user_accounts_no_delete` guard exception safe is
 * that exactly one place in the whole application issues `DELETE FROM
 * accounts`. If a second call site ever appears -- a generic repository
 * method, a Company-portal route, a script -- it would inherit the same
 * exception this migration grants, without having done any of the
 * eligibility, last-administrator, or confirmation checks first.
 *
 * Test fixtures and cleanup helpers are excluded deliberately: they run
 * against disposable fixture data outside any request path, and are not
 * reachable by an application caller.
 */
describe("No path other than the Platform deletion service deletes accounts", () => {
  const srcRoot = join(process.cwd(), "src");
  const pattern = /delete\s+from\s+accounts\b/i;

  const collectSourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      if (!entry.name.endsWith(".ts")) return [];
      if (entry.name.includes(".test.") || entry.name.includes(".spec.")) return [];
      if (entry.name.includes("database-test-helpers")) return [];
      return [path];
    });

  it("only platform-user-deletion.service.ts issues DELETE FROM accounts", () => {
    const matches = collectSourceFiles(srcRoot).filter((path) => pattern.test(readFileSync(path, "utf8")));
    const relative = matches.map((path) => path.slice(srcRoot.length + 1).replace(/\\/g, "/"));
    expect(relative).toEqual(["platform/platform-user-deletion.service.ts"]);
  });
});
