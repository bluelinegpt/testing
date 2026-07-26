import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kysely, PostgresDialect } from "kysely";
import { Logger } from "nestjs-pino";
import { Pool } from "pg";

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

@Global()
@Module({
  exports: [DATABASE, DatabaseHealthService, KyselyTransactionManager],
  providers: [
    {
      inject: [ConfigService, Logger],
      provide: DATABASE_POOL,
      useFactory(config: ConfigService<AppConfiguration, true>, logger: Logger): Pool {
        return registerDatabasePoolErrorHandler(
          new Pool({
            application_name: "blueline-api",
            connectionTimeoutMillis: config.get("database.connectionTimeoutMs", { infer: true }),
            connectionString: config.get("database.url", { infer: true }),
            max: config.get("database.poolMax", { infer: true }),
            min: config.get("database.poolMin", { infer: true }),
            query_timeout: config.get("database.queryTimeoutMs", { infer: true }),
          }),
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
