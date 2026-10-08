import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { normalizeReferenceTerm } from "./order-search.js";
import { isSearchList, orderNumberCandidates } from "./search-list.js";

export interface ResolvedOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly version: number;
}

/** Characters that turn a value into a pattern. The lookup is exact-match only. */
const WILDCARDS = /[*%]/u;

/** Never act on more than one Order: at most this many candidates are reported back. */
const CANDIDATE_LIMIT = 20;

/**
 * Repair Center lookup: one typed value -> exactly one Order of ONE Company.
 *
 * The Company comes only from the route. The value is an Order Number (full,
 * lower case or bare digits, via `orderNumberCandidates`) or a Reference
 * Number matched exactly on `reference_number_normalized`. Lists, commas and
 * wildcards are refused rather than interpreted, and a value that matches more
 * than one Order is refused with the candidates, so the operator re-enters the
 * exact one. Every later call takes the resolved id and version, never the text.
 */
@Injectable()
export class OrderValidationLookup {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async resolve(companyId: string, query: string): Promise<ResolvedOrder> {
    const value = query.normalize("NFKC").trim();
    if (value === "" || isSearchList(value) || WILDCARDS.test(value)) {
      throw new ApplicationException(
        "order_lookup_invalid",
        "Enter exactly one Order Number or Reference Number.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const candidates = orderNumberCandidates(value);
    const reference = normalizeReferenceTerm(value);
    const result = await sql<ResolvedOrder>`
      select id as "orderId", order_number as "orderNumber",
             reference_number as "referenceNumber", version::int as version
        from orders
       where company_id = ${companyId}::uuid
         and (order_number = any(${candidates}::text[])
              or reference_number_normalized = ${reference})
       order by order_number
       limit ${CANDIDATE_LIMIT + 1}
    `.execute(this.database);
    if (result.rows.length === 0) {
      throw new ApplicationException("order_not_found", "Order not found.", HttpStatus.NOT_FOUND);
    }
    if (result.rows.length > 1) {
      throw new ApplicationException(
        "order_lookup_ambiguous",
        "More than one Order matches this value. Enter the exact Order Number.",
        HttpStatus.CONFLICT,
        result.rows.slice(0, CANDIDATE_LIMIT).map((row) => row.orderNumber),
      );
    }
    return result.rows[0]!;
  }
}
