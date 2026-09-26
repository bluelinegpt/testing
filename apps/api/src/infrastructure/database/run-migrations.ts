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
const legacyAssignmentMigration = await sql<{ exists: boolean }>`
  select exists (
    select 1 from kysely_migration
    where name = '20260902012000_collect_order_assignment_customer_optional'
  ) as "exists"
`.execute(database);
const hasLegacyAssignmentMigration = legacyAssignmentMigration.rows[0]?.exists === true;
const legacyHistoricalClassificationMigration = await sql<{ exists: boolean }>`
  select exists (
    select 1 from kysely_migration
    where name = '20260964000000_resolve_historical_accounting_event_classification'
  ) as "exists"
`.execute(database);
const hasLegacyHistoricalClassificationMigration = legacyHistoricalClassificationMigration.rows[0]?.exists === true;
const legacyInternationalOrderFoundationMigration = await sql<{ exists: boolean }>`
  select exists (select 1 from kysely_migration where name = '20260973000000_gcc_international_order_type') as "exists"
`.execute(database);
const hasLegacyInternationalOrderFoundationMigration = legacyInternationalOrderFoundationMigration.rows[0]?.exists === true;
const legacyInternationalCarrierMigration = await sql<{ exists: boolean }>`
  select exists (select 1 from kysely_migration where name = '20260974000000_international_carrier_status') as "exists"
`.execute(database);
const hasLegacyInternationalCarrierMigration = legacyInternationalCarrierMigration.rows[0]?.exists === true;
const legacyInternationalOrderSchema = await sql<{ exists: boolean }>`
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'destination_country_id'
  ) and exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'destination_countries'
  ) as "exists"
`.execute(database);
const hasLegacyInternationalOrderSchema = legacyInternationalOrderSchema.rows[0]?.exists === true;
const legacyInternationalCarrierSchema = await sql<{ exists: boolean }>`
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'international_carrier_status'
  ) and exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'orders' and indexname = 'orders_company_international_carrier_status_idx'
  ) as "exists"
`.execute(database);
const hasLegacyInternationalCarrierSchema = legacyInternationalCarrierSchema.rows[0]?.exists === true;
if (hasLegacyInternationalOrderFoundationMigration && !hasLegacyInternationalOrderSchema) {
  throw new Error("Legacy International order migration is recorded but its schema is missing");
}
if (hasLegacyInternationalCarrierMigration && !hasLegacyInternationalCarrierSchema) {
  throw new Error("Legacy International carrier migration is recorded but its schema is missing");
}
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
    if (hasLegacyAssignmentMigration) {
      migrations["20260902012000_collect_order_assignment_customer_optional"] ??= {
        async up(db) {
          await sql`select 1`.execute(db);
        },
        async down(db) {
          await sql`select 1`.execute(db);
        },
      };
      delete migrations["20260902012500_collect_order_assignment_customer_optional"];
    }
    /**
     * The historical accounting classification migration was renamed twice
     * after one environment had already recorded the original timestamp.
     * Keep the recorded name available as a virtual no-op for that existing
     * database, while fresh databases run the current file normally.
     */
    if (hasLegacyHistoricalClassificationMigration) {
      migrations["20260964000000_resolve_historical_accounting_event_classification"] ??= {
        async up(db) {
          await sql`select 1`.execute(db);
        },
        async down(db) {
          await sql`select 1`.execute(db);
        },
      };
      delete migrations["20260972500000_resolve_historical_accounting_event_classification"];
    }
    if (hasLegacyInternationalOrderFoundationMigration) {
      migrations["20260973000000_gcc_international_order_type"] ??= {
        async up(db) { await sql`select 1`.execute(db); },
        async down(db) { await sql`select 1`.execute(db); },
      };
      delete migrations["20260975000000_gcc_international_order_type"];
    }
    if (hasLegacyInternationalCarrierMigration) {
      migrations["20260974000000_international_carrier_status"] ??= {
        async up(db) { await sql`select 1`.execute(db); },
        async down(db) { await sql`select 1`.execute(db); },
      };
      delete migrations["20260976000000_international_carrier_status"];
    }
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
