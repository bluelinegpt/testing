import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kysely, PostgresDialect } from "kysely";
import { Logger } from "nestjs-pino";
import { Pool, type PoolConfig } from "pg";

import type { AppConfiguration } from "../../configuration/environment.js";
import { DatabaseHealthService } from "./database-health.service.js";
import { DATABASE, DATABASE_POOL } from "./database.tokens.js";
import type { DatabaseSchema } from "./database.types.js";
import { KyselyTransactionManager } from "./transaction-manager.js";

export function registerDatabasePoolErrorHandler(pool: Pool, logger: Pick<Logger, "error">): Pool {
  pool.on("error", (error) => {
    logger.error({ err: error }, "Unexpected idle PostgreSQL client error");
  });
  return pool;
}

export interface DatabasePoolSettings {
  readonly connectionTimeoutMs: number;
  readonly poolMax: number;
  readonly poolMin: number;
  readonly statementTimeoutMs: number;
  readonly url: string;
}

/** A transaction left open and idle is ended by PostgreSQL after this long. */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Pool options. The query limit is enforced by PostgreSQL (`statement_timeout`),
 * NOT by the client (`query_timeout`) -- Lahthza incident, 15 Nov 2026.
 *
 * The client-side `query_timeout` only stops the API from waiting: the query
 * keeps running, and the connection goes back to the pool still inside its
 * transaction. The next request's BEGIN is then ignored ("there is already a
 * transaction in progress") and its COMMIT also commits the abandoned
 * half-done work -- that is how SET-000278..282 were left as drafts without
 * a payment. A server-side timeout cancels the statement, the whole
 * transaction is rolled back, and the connection comes back clean.
 */
export function databasePoolOptions(settings: DatabasePoolSettings): PoolConfig {
  return {
    application_name: "blueline-api",
    connectionString: settings.url,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    keepAlive: true,
    max: settings.poolMax,
    min: settings.poolMin,
    statement_timeout: settings.statementTimeoutMs,
  };
}

@Global()
@Module({
  exports: [DATABASE, DatabaseHealthService, KyselyTransactionManager],
  providers: [
    {
      inject: [ConfigService, Logger],
      provide: DATABASE_POOL,
      useFactory(config: ConfigService<AppConfiguration, true>, logger: Logger): Pool {
        return registerDatabasePoolErrorHandler(
          new Pool(
            databasePoolOptions({
              connectionTimeoutMs: config.get("database.connectionTimeoutMs", { infer: true }),
              poolMax: config.get("database.poolMax", { infer: true }),
              poolMin: config.get("database.poolMin", { infer: true }),
              statementTimeoutMs: config.get("database.queryTimeoutMs", { infer: true }),
              url: config.get("database.url", { infer: true }),
            }),
          ),
          logger,
        );
      },
    },
    {
      inject: [DATABASE_POOL],
      provide: DATABASE,
      useFactory(pool: Pool): Kysely<DatabaseSchema> {
        return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
      },
    },
    DatabaseHealthService,
    KyselyTransactionManager,
  ],
})
export class DatabaseModule implements OnApplicationShutdown {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
