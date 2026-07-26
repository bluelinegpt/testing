import type { Logger } from "nestjs-pino";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDatabasePoolErrorHandler } from "./database.module.js";

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
