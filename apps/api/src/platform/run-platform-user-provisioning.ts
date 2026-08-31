import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { provisionPlatformSeoConsultant } from "./platform-user-provisioning.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const username = process.env.BLUELINE_PLATFORM_USER_USERNAME?.trim();
const email = process.env.BLUELINE_PLATFORM_USER_EMAIL?.trim();
const temporaryPassword = process.env.BLUELINE_PLATFORM_USER_TEMPORARY_PASSWORD;
if (!username || !email || !temporaryPassword) {
  throw new Error(
    "BLUELINE_PLATFORM_USER_USERNAME, BLUELINE_PLATFORM_USER_EMAIL and " +
      "BLUELINE_PLATFORM_USER_TEMPORARY_PASSWORD are required",
  );
}
const settings = configuration();
const pool = new Pool({
  application_name: "blueline-platform-user-provisioning",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
try {
  const accountId = await provisionPlatformSeoConsultant(database, {
    email,
    temporaryPassword,
    username,
  });
  process.stdout.write(`Platform SEO Consultant provisioned (${accountId})\n`);
} finally {
  await database.destroy();
}
