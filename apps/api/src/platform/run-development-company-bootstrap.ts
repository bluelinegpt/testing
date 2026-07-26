import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

import { bootstrapDevelopmentCompany } from "./development-company-bootstrap.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const subdomain = process.env.BLUELINE_DEV_COMPANY_SUBDOMAIN?.trim().toLowerCase();
const username = process.env.BLUELINE_DEV_COMPANY_USERNAME?.trim();
const password = process.env.BLUELINE_DEV_COMPANY_PASSWORD;
const companyName = process.env.BLUELINE_DEV_COMPANY_NAME?.trim() ?? "Blueline Demo Company";

if (subdomain === undefined || username === undefined || password === undefined) {
  throw new Error(
    "BLUELINE_DEV_COMPANY_SUBDOMAIN, BLUELINE_DEV_COMPANY_USERNAME, and BLUELINE_DEV_COMPANY_PASSWORD are required",
  );
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
  throw new Error("Development Company subdomain is invalid");
}
if (!/^[A-Za-z0-9._@-]{3,128}$/.test(username)) {
  throw new Error("Development username is invalid");
}
if (password.length < 12 || password.length > 256) {
  throw new Error("Development password must be between 12 and 256 characters");
}

const settings = configuration();
if (settings.app.environment === "production") {
  throw new Error("Development Company bootstrap is disabled in production");
}

const pool = new Pool({
  application_name: "blueline-development-company-bootstrap",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

try {
  const passwordHash = await new PasswordHasher().hash(password);
  const identifiers = await database.transaction().execute(async (transaction) =>
    bootstrapDevelopmentCompany(transaction, {
      companyName,
      passwordHash,
      subdomain,
      username,
    }),
  );
  process.stdout.write(
    `Development Company bootstrap completed: ${identifiers.companyId} / ${identifiers.accountId}\n`,
  );
} finally {
  await database.destroy();
}
