import type { Logger } from "nestjs-pino";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATABASE_SESSION_OPTIONS,
  databasePoolOptions,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  registerDatabasePoolErrorHandler,
} from "./database.module.js";

describe("registerDatabasePoolErrorHandler", () => {
  const pools: Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it("handles and safely logs an unexpected idle client error", () => {
    const pool = new Pool();
    pools.push(pool);
    const logger = { error: vi.fn() } as unknown as Pick<Logger, "error">;
    const error = new Error("database connection lost");

    registerDatabasePoolErrorHandler(pool, logger);

    expect(() => pool.emit("error", error, undefined)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      { err: error },
      "Unexpected idle PostgreSQL client error",
    );
  });
});

describe("databasePoolOptions", () => {
  const options = databasePoolOptions({
    connectionTimeoutMs: 5000,
    poolMax: 10,
    poolMin: 0,
    statementTimeoutMs: 30000,
    url: "postgresql://blueline:secret@db:5432/bluelinegpt",
  });

  it("lets PostgreSQL enforce the query limit, so a timeout rolls the transaction back", () => {
    expect(options.statement_timeout).toBe(30000);
    expect(options.idle_in_transaction_session_timeout).toBe(IDLE_IN_TRANSACTION_TIMEOUT_MS);
  });

  it("turns JIT off for the API's sessions, so a short request never pays for compilation", () => {
    expect(options.options).toBe(DATABASE_SESSION_OPTIONS);
    expect(DATABASE_SESSION_OPTIONS).toContain("jit=off");
  });

  it("never uses the client-side query_timeout, which leaves a transaction open on the pooled connection", () => {
    expect(options).not.toHaveProperty("query_timeout");
  });

  it("keeps the pool sizing and connection settings", () => {
    expect(options).toMatchObject({
      application_name: "blueline-api",
      connectionTimeoutMillis: 5000,
      max: 10,
      min: 0,
    });
  });
});
