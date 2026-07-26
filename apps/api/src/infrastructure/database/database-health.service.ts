import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "./database.tokens.js";
import type { DatabaseSchema } from "./database.types.js";

@Injectable()
export class DatabaseHealthService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async check(): Promise<void> {
    await sql`select 1`.execute(this.database);
  }
}
