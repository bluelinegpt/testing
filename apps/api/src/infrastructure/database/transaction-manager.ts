import { Inject, Injectable } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";

import { DATABASE } from "./database.tokens.js";
import type { DatabaseSchema } from "./database.types.js";

export type TransactionWork<T> = (transaction: Transaction<DatabaseSchema>) => Promise<T>;

@Injectable()
export class KyselyTransactionManager {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    return this.database.transaction().execute(work);
  }
}
