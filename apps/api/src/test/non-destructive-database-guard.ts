import { URL } from "node:url";

const databaseTestFlags = [
  "RUN_ADMINISTRATION_INTEGRATION",
  "RUN_COMPANY_PROFILE_DATABASE",
  "RUN_DATABASE_INTEGRATION",
  "RUN_FIXTURE_DATABASE",
  "RUN_INTEGRITY_DATABASE",
  "RUN_PROVISIONING_DATABASE",
  "RUN_RECONCILIATION_DATABASE",
  "RUN_RECONCILIATION_HTTP",
  "RUN_SETTLEMENT_DATABASE",
  "RUN_SETTLEMENT_HTTP",
] as const;

export function databaseTestsRequested(environment = process.env): boolean {
  return databaseTestFlags.some((flag) => environment[flag] === "true");
}

export function assertNonDestructiveDatabaseTestPreflight(environment = process.env): void {
  if (!databaseTestsRequested(environment)) return;
  if (environment.NODE_ENV !== "test") {
    throw new Error("Database tests require NODE_ENV=test.");
  }
  if (environment.BLUELINE_ALLOW_NON_DESTRUCTIVE_DB_TESTS !== "1") {
    throw new Error("Database tests require BLUELINE_ALLOW_NON_DESTRUCTIVE_DB_TESTS=1.");
  }
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("Database tests require DATABASE_URL.");
  }
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("Database tests require a PostgreSQL DATABASE_URL.");
  }
  const databaseName = parsed.pathname.replace(/^\//, "");
  if (databaseName !== "blueline") {
    throw new Error("Non-destructive Prompt 11C database tests must target blueline.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Non-destructive Prompt 11C database tests must target local PostgreSQL.");
  }
}
