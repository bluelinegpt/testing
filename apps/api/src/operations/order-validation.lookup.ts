import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { isSearchList, orderNumberCandidates } from "./search-list.js";
import { normalizeReferenceTerm } from "./order-search.js";

export interface ResolvedOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly version: number;
}

@Injectable()
export class OrderValidationLookup {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async resolve(companyId: string, query: string): Promise<ResolvedOrder> {
    const value = query.trim();
    if (value === "" || isSearchList(value) || /[*%]/u.test(value)) {
      throw new BadRequestException({ code: "order_lookup_invalid", message: "Enter one Order Number or Reference Number." });
    }
    const candidates = orderNumberCandidates(value);
    const reference = normalizeReferenceTerm(value);
    const result = await sql<ResolvedOrder>`
      select id as "orderId", order_number as "orderNumber", reference_number as "referenceNumber", version
        from orders
       where company_id = ${companyId}::uuid
         and (order_number = any(${candidates}::text[])
              or reference_number_normalized = ${reference})
       order by order_number
       limit 20
    `.execute(this.database);
    if (result.rows.length === 0) {
      throw new NotFoundException({ code: "order_not_found", message: "Order not found." });
    }
    if (result.rows.length > 1) {
      throw new ConflictException({
        code: "order_lookup_ambiguous",
        message: "More than one Order matches this value.",
        candidates: result.rows.map((row) => row.orderNumber),
      });
    }
    return result.rows[0]!;
  }
}
