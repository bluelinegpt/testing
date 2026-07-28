import { randomUUID } from "node:crypto";
import { promises as fileSystem } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";

import type { ConfigService } from "@nestjs/config";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { configuration } from "../configuration/environment.js";
import type { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext, IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContext, TenantContextAccessor } from "../tenancy/tenant-context.js";

import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import type { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Disposable schema for real multi-connection concurrency tests.
 *
 * The single-connection savepoint harness cannot exercise lock contention, so
 * these tests need committed transactions on separate connections. The
 * development role cannot create databases, so a throwaway schema is created,
 * migrated, used and dropped instead. Every connection sets `search_path` to
 * that schema, so all writes — including committed ones — land there and the
 * development data in `public` is never touched.
 */
export interface DisposableDatabase {
  /** Row counts in `public` captured before any test wrote anything. */
  readonly baseline: Readonly<Record<string, number>>;
  readonly connectionString: string;
  drop: () => Promise<void>;
  readonly name: string;
  /** Throws if any row was added to `public` while the tests ran. */
  assertPublicUnchanged: () => Promise<void>;
}

/** Disposable schemas must carry this prefix; anything else is refused. */
const disposableSchemaPrefix = "blueline_concurrency_";

/** Tables whose resolution is asserted before any fixture insert. */
const requiredTables = [
  "companies",
  "orders",
  "driver_reconciliations",
  "driver_reconciliation_orders",
  "driver_reconciliation_payments",
  "order_events",
  "order_status_history",
] as const;

const baselineTables = [
  "companies",
  "orders",
  "driver_reconciliations",
  "driver_reconciliation_payments",
  "audit_events",
] as const;

async function readPublicCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of baselineTables) {
    const result = await pool.query<{ value: number }>(
      `select count(*)::int as value from public.${table}`,
    );
    counts[table] = result.rows[0]?.value ?? -1;
  }
  return counts;
}

function schemaConnectionString(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const baseUrl = configuration().database.url;
  const name = `blueline_concurrency_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`create schema ${name}`);
  } finally {
    await admin.end();
  }

  const connectionString = schemaConnectionString(baseUrl, name);
  const pool = new Pool({ connectionString, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  try {
    const migrator = new Migrator({
      db: database,
      // The migration-tracking table MUST live in the disposable schema. Without
      // this, the search_path falls through to public, the migrator reads the
      // development database's completed migrations, creates nothing, and every
      // subsequent write silently lands in public instead of the test schema.
      migrationTableSchema: name,
      provider: new FileMigrationProvider({
        fs: fileSystem,
        import: (modulePath) => import(pathToFileURL(modulePath).href),
        migrationFolder: resolve(process.cwd(), "../../database/migrations"),
        path: { join: (...parts: string[]) => resolve(...parts) },
      }),
    });
    const result = await migrator.migrateToLatest();
    if (result.error !== undefined) throw result.error;
    await assertIsolation(database, name);
  } finally {
    await database.destroy();
  }

  const baselinePool = new Pool({ connectionString: baseUrl, max: 1 });
  let baseline: Record<string, number>;
  try {
    baseline = await readPublicCounts(baselinePool);
  } finally {
    await baselinePool.end();
  }

  return {
    assertPublicUnchanged: async () => {
      const checkPool = new Pool({ connectionString: baseUrl, max: 1 });
      try {
        const after = await readPublicCounts(checkPool);
        for (const [table, before] of Object.entries(baseline)) {
          if (after[table] !== before) {
            throw new Error(
              `Test isolation failed: public.${table} changed from ${before} to ${after[table]}`,
            );
          }
        }
      } finally {
        await checkPool.end();
      }
    },
    baseline,
    connectionString,
    drop: async () => {
      const cleanup = new Pool({ connectionString: baseUrl, max: 1 });
      try {
        await cleanup.query(`drop schema if exists ${name} cascade`);
      } finally {
        await cleanup.end();
      }
    },
    name,
  };
}

/**
 * Refuses to proceed unless the connection is genuinely isolated.
 *
 * This exists because a missing `migrationTableSchema` once let the migrator read
 * `public`'s completed migrations, create nothing in the disposable schema, and
 * silently write every test row into the development database.
 */
export async function assertIsolation(
  database: Kysely<DatabaseSchema>,
  expectedSchema: string,
): Promise<void> {
  if (!expectedSchema.startsWith(disposableSchemaPrefix)) {
    throw new Error(`Disposable schema must start with ${disposableSchemaPrefix}`);
  }
  const current = await sql<{ schema: string | null }>`
    select current_schema() as schema
  `.execute(database);
  const schema = current.rows[0]?.schema;
  if (schema === "public") {
    throw new Error("Refusing to run: current_schema() is public");
  }
  if (schema !== expectedSchema) {
    throw new Error(`Refusing to run: current_schema() is ${schema}, expected ${expectedSchema}`);
  }
  for (const table of requiredTables) {
    const resolved = await sql<{ schema: string | null }>`
      select to_regclass(${table})::regclass::text as schema
    `.execute(database);
    const present = await sql<{ value: number }>`
      select count(*)::int as value from pg_tables
       where schemaname = ${expectedSchema} and tablename = ${table}
    `.execute(database);
    if ((present.rows[0]?.value ?? 0) === 0) {
      throw new Error(
        `Refusing to run: ${table} does not exist in ${expectedSchema} ` +
          `(resolves to ${resolved.rows[0]?.schema ?? "nothing"})`,
      );
    }
  }
}

class MutableTenantAccessor {
  public constructor(private context: TenantContext) {}
  public current(): TenantContext {
    return this.context;
  }
  public async run<T>(context: TenantContext, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

class MutableIdentityAccessor {
  public constructor(private context: IdentityContext) {}
  public current(): IdentityContext {
    return this.context;
  }
}

/**
 * One independent "caller": its own pool, its own connection, its own real
 * transaction manager. Two callers therefore contend for locks exactly as two
 * API requests would.
 */
export interface Caller {
  readonly database: Kysely<DatabaseSchema>;
  destroy: () => Promise<void>;
  readonly service: DriverCashReconciliationService;
  readonly traderSettlementService: TraderSettlementService;
}

export function createCaller(
  connectionString: string,
  companyId: string,
  accountId: string,
  options: { readonly lockTimeoutMs?: number } = {},
): Caller {
  // The search_path already rides on the connection string; a lock timeout is
  // applied per statement so a hung wait surfaces as a failure, never a hang.
  const pool = new Pool({ connectionString, max: 2 });
  if (options.lockTimeoutMs !== undefined) {
    pool.on("connect", (client) => {
      void client.query(`set lock_timeout = ${options.lockTimeoutMs}`);
    });
  }
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const transactions = new KyselyTransactionManager(database);
  const tenants = new MutableTenantAccessor({ companyId, identityId: accountId });
  const identities = new MutableIdentityAccessor({
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "company_user",
    permissions: new Set([
      "reconciliations.create",
      "reconciliations.reverse",
      "settlements.create",
      "settlements.reverse",
    ]),
    sessionId: randomUUID(),
  });
  const companyProfile = new CompanyProfileService(
    database,
    transactions,
    tenants as unknown as TenantContextAccessor,
    identities as unknown as IdentityContextAccessor,
    {} as unknown as FileStoragePort,
    { get: () => "local" } as unknown as ConfigService<AppConfiguration, true>,
  );
  const service = new DriverCashReconciliationService(
    database,
    transactions,
    tenants as unknown as TenantContextAccessor,
    identities as unknown as IdentityContextAccessor,
    new OperationsHistoryWriter(),
    companyProfile,
    {} as unknown as DriverCollectionPdfService,
  );
  const traderSettlementService = new TraderSettlementService(
    database,
    transactions,
    tenants as unknown as TenantContextAccessor,
    identities as unknown as IdentityContextAccessor,
    new OperationsHistoryWriter(),
    companyProfile,
  );
  return {
    database,
    destroy: () => database.destroy(),
    service,
    traderSettlementService,
  };
}
