import { existsSync, promises as fileSystem } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { FileMigrationProvider, Migrator, type Migration, type MigrationProvider } from "kysely/migration";
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
const fileMigrationProvider = new FileMigrationProvider({
  fs: fileSystem,
  import: (modulePath) => import(pathToFileURL(modulePath).href),
  migrationFolder,
  path: { join: (...parts: string[]) => resolve(...parts) },
});
const provider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations = await fileMigrationProvider.getMigrations();
    /**
     * One Neon environment briefly recorded this migration under the
     * colliding 20260902012000 timestamp before the repair was renamed to
     * 20260902012500. Kysely treats any executed-but-missing name as
     * corruption, so keep a virtual no-op alias available to unblock that
     * environment without adding a duplicate timestamp file or mutating data.
     */
    migrations["20260902012000_collect_order_assignment_customer_optional"] ??= {
      async up(db) {
        await sql`select 1`.execute(db);
      },
      async down(db) {
        await sql`select 1`.execute(db);
      },
    };
    return migrations;
  },
};
const migrator = new Migrator({
  db: database,
  provider,
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
