import { Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { LEGACY_MIGRATION_ALIASES } from "../infrastructure/database/migration-compatibility.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";

@Injectable()
export class MigrationStateService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async state() {
    const result = await sql<{ name: string; timestamp: string; executedAt: string }>`
      select name, timestamp::text as "timestamp", executed_at::text as "executedAt"
      from kysely_migration order by timestamp, name
    `.execute(this.database);
    const recorded = new Set(result.rows.map((row) => row.name));
    return {
      allowUnorderedMigrations: true,
      migrations: result.rows,
      legacyAliases: LEGACY_MIGRATION_ALIASES.map((alias) => ({
        ...alias,
        recorded: recorded.has(alias.legacyName),
      })),
    };
  }
}
