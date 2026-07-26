import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { bootstrapPlatformAdministrator } from "./platform-administrator-bootstrap.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const username = process.env.BLUELINE_BOOTSTRAP_USERNAME?.trim();
const password = process.env.BLUELINE_BOOTSTRAP_PASSWORD;
if (username === undefined || username.length === 0 || password === undefined) {
  throw new Error(
    "BLUELINE_BOOTSTRAP_USERNAME and BLUELINE_BOOTSTRAP_PASSWORD are required for this one-time command",
  );
}

const settings = configuration();
const pool = new Pool({
  application_name: "blueline-platform-bootstrap",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

try {
  const accountId = await bootstrapPlatformAdministrator(database, { password, username });
  process.stdout.write(`Platform administrator bootstrap completed: ${accountId}\n`);
} finally {
  await database.destroy();
}
