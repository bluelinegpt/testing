import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

import { assertIsolation } from "./concurrency-harness.js";

const runIsolationTests = process.env.RUN_CONCURRENCY_DATABASE === "true";

describe.skipIf(!runIsolationTests)("concurrency harness isolation guard", () => {
  it("refuses to run against public and rejects non-disposable schema names", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      // A plain connection resolves to public, which must be refused outright.
      await expect(assertIsolation(database, "blueline_concurrency_probe")).rejects.toThrow(
        /current_schema\(\) is public/,
      );
      // A schema name without the test-only prefix is refused before any query.
      await expect(assertIsolation(database, "public")).rejects.toThrow(
        /must start with blueline_concurrency_/,
      );
      await expect(assertIsolation(database, "some_other_schema")).rejects.toThrow(
        /must start with blueline_concurrency_/,
      );
    } finally {
      await database.destroy();
    }
  }, 60_000);
});
