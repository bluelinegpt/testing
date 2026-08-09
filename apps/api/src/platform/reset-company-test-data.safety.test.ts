import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Mechanical safety test for the reset tooling.
 *
 * The dry-run path must have no capability to change data. This test reads the source of
 * every module that path is built from and fails if any statement that could change or
 * discard data appears in it.
 *
 * Do not add exclusions to these patterns, and do not add a module to READ_ONLY_MODULES'
 * ignore list to make it pass. An exclusion that permits a real data-changing statement
 * removes the only mechanical guarantee that the dry run is read-only. Data-changing
 * capability belongs in the execution engine, which is a separate module the dry-run path
 * does not import, and which is gated by --execute plus a matching confirmation.
 */

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/** Every module reachable from the dry run. All of these must be read-only. */
const READ_ONLY_MODULES = ["reset-company-test-data.ts", "reset-company-test-data.manifest.ts"];

const engine = read("reset-company-test-data.engine.ts");
const cli = read("reset-company-test-data.cli.ts");

const FORBIDDEN = [
  "delete",
  "truncate",
  "drop",
  "insert",
  "update",
  "alter",
  "grant",
  "revoke",
  "--execute",
];

describe("read-only dry-run path", () => {
  it.each(READ_ONLY_MODULES)("%s contains no data-changing operation", (name) => {
    const source = read(name).toLowerCase();
    expect(FORBIDDEN.filter((token) => source.includes(token))).toEqual([]);
  });

  it.each(READ_ONLY_MODULES)("%s never imports the execution engine", (name) => {
    expect(read(name)).not.toContain("reset-company-test-data.engine");
  });

  it("opens an explicitly read-only transaction", () => {
    expect(read("reset-company-test-data.ts")).toContain("begin transaction read only");
  });
});

describe("execution engine safety gates", () => {
  it("restores every suspended guard and proves it before commit", () => {
    expect(engine).toContain("enable trigger");
    expect(engine).toContain("tgenabled <> 'O'");
    expect(engine).toContain("Refusing to commit — guards were not restored");
  });

  it("scopes every removal statement to one Company", () => {
    const statements = engine.match(/delete from [^`]*`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toContain("where company_id = $1");
    }
  });

  it("refuses a guard that is not in the approved procedure", () => {
    expect(engine).toContain("not in the approved procedure");
  });

  it("refuses to suspend a parent-total guard unless the parent is cleared", () => {
    expect(engine).toContain("requiresCleared");
    expect(engine).toContain("before a ");
  });

  it("verifies preserved configuration is unchanged before commit", () => {
    expect(engine).toContain("preserved configuration changed");
  });

  it("never commits or rolls back on its own — the caller owns the transaction", () => {
    expect(engine).not.toMatch(/query\("commit"\)/);
    expect(engine).not.toMatch(/query\("rollback"\)/);
  });
});

describe("command-line gates", () => {
  it("requires both --execute and a matching confirmation", () => {
    expect(cli).toContain("--confirm-company-id");
    expect(cli).toContain("does not match");
  });

  it("refuses production with no bypass", () => {
    expect(cli).toContain("the application environment is production");
    expect(cli).toContain("There is no bypass");
  });

  it("rolls back and reports on failure", () => {
    expect(cli).toContain("RESET_ROLLED_BACK");
  });

  it("never silently skips the backup", () => {
    expect(cli).toContain("--allow-no-backup");
    expect(cli).toContain("no backup can be taken");
  });
});

describe("manifest invariants", () => {
  it("classification lists do not overlap", () => {
    const source = read("reset-company-test-data.manifest.ts");
    const lists = ["PURGE_TABLES", "PRESERVE_TABLES", "CONDITIONAL_TABLES"];
    const entries = new Map<string, string[]>();
    for (const list of lists) {
      const start = source.indexOf(`export const ${list} = new Set`);
      expect(start, `${list} not found`).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf("]);", start));
      entries.set(
        list,
        [...block.matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((match) => match[1] ?? ""),
      );
    }
    for (const [list, tables] of entries) {
      expect(new Set(tables).size, `${list} has a repeated entry`).toBe(tables.length);
      for (const [otherList, otherTables] of entries) {
        if (list === otherList) {
          continue;
        }
        expect(
          tables.filter((table) => otherTables.includes(table)),
          `${list} and ${otherList} overlap`,
        ).toEqual([]);
      }
    }
  });
});
