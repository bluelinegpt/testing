import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { resetPlatformAdministratorPassword } from "./platform-administrator-password-reset.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const username = process.env.BLUELINE_RESET_USERNAME?.trim();
const password = process.env.BLUELINE_RESET_PASSWORD;
if (username === undefined || username.length === 0 || password === undefined) {
  throw new Error(
    "BLUELINE_RESET_USERNAME and BLUELINE_RESET_PASSWORD are required for this command. " +
      "Set them as local environment variables for this one invocation only -- never commit " +
      "them, and never paste the password anywhere it could be logged.",
  );
}

const settings = configuration();
const pool = new Pool({
  application_name: "blueline-platform-admin-password-reset",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

try {
  const accountId = await resetPlatformAdministratorPassword(database, { password, username });
  process.stdout.write(`Platform administrator password reset completed: ${accountId}\n`);
} finally {
  await database.destroy();
}
