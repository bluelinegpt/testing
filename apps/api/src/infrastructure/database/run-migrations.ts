import { existsSync, promises as fileSystem } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";

import { configuration } from "../../configuration/environment.js";
import type { DatabaseSchema } from "./database.types.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const settings = configuration();
// Source workspaces keep migrations at the repository root. The production
// image copies them below the deployed API so imports inside each migration
// resolve the API's own Kysely dependency instead of looking for a nonexistent
// /opt/app/node_modules directory.
const deployedMigrationFolder = resolve(process.cwd(), "database/migrations");
const migrationFolder = existsSync(deployedMigrationFolder)
  ? deployedMigrationFolder
  : resolve(process.cwd(), "../../database/migrations");
const pool = new Pool({
  application_name: "blueline-migrations",
  connectionTimeoutMillis: settings.database.connectionTimeoutMs,
  connectionString: settings.database.url,
  max: 1,
  query_timeout: settings.database.queryTimeoutMs,
});
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
const migrator = new Migrator({
  db: database,
  provider: new FileMigrationProvider({
    fs: fileSystem,
    import: (modulePath) => import(pathToFileURL(modulePath).href),
    migrationFolder,
    path: { join: (...parts: string[]) => resolve(...parts) },
  }),
});

try {
  const direction = process.argv[2] ?? "up";
  const result =
    direction === "down" ? await migrator.migrateDown() : await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error;
  }
  for (const migration of result.results ?? []) {
    process.stdout.write(`${migration.migrationName}: ${migration.status}\n`);
  }
} finally {
  await database.destroy();
}
