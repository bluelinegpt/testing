import { describe, expect, it } from "vitest";

import { assertNonDestructiveDatabaseTestPreflight } from "./non-destructive-database-guard.js";

const baseEnvironment = {
  BLUELINE_ALLOW_NON_DESTRUCTIVE_DB_TESTS: "1",
  DATABASE_URL: "postgresql://user:password@localhost:5432/blueline",
  NODE_ENV: "test",
  RUN_INTEGRITY_DATABASE: "true",
};

describe("non-destructive database test preflight", () => {
  it("allows explicitly flagged local blueline database tests", () => {
    expect(() => assertNonDestructiveDatabaseTestPreflight(baseEnvironment)).not.toThrow();
  });

  it("rejects missing test environment", () => {
    expect(() =>
      assertNonDestructiveDatabaseTestPreflight({ ...baseEnvironment, NODE_ENV: "development" }),
    ).toThrow(/NODE_ENV=test/);
  });

  it("rejects missing non-destructive safety flag", () => {
    expect(() =>
      assertNonDestructiveDatabaseTestPreflight({
        ...baseEnvironment,
        BLUELINE_ALLOW_NON_DESTRUCTIVE_DB_TESTS: undefined,
      }),
    ).toThrow(/BLUELINE_ALLOW_NON_DESTRUCTIVE_DB_TESTS=1/);
  });

  it("rejects a non-blueline database", () => {
    expect(() =>
      assertNonDestructiveDatabaseTestPreflight({
        ...baseEnvironment,
        DATABASE_URL: "postgresql://user:password@localhost:5432/blueline_test",
      }),
    ).toThrow(/must target blueline/);
  });

  it("rejects non-local hosts", () => {
    expect(() =>
      assertNonDestructiveDatabaseTestPreflight({
        ...baseEnvironment,
        DATABASE_URL: "postgresql://user:password@staging.example.com:5432/blueline",
      }),
    ).toThrow(/local PostgreSQL/);
  });
});
