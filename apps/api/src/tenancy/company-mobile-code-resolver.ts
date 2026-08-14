import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Resolves a Company from its six-digit Mobile Code.
 *
 * The mobile app's counterpart to `CompanyHostResolver`: one installed app
 * serves every Company, so there is no host to read the tenant from — the
 * device sends the code it stored at first launch (scanned from the portal's
 * QR panel or a printed report, or typed by hand) in the
 * `x-blueline-company-code` header instead.
 *
 * Trusting the header is equivalent to trusting the Host header on the web:
 * both merely AIM the login at a Company, neither grants access, and an
 * unknown code produces `undefined` — which the caller answers with the same
 * generic invalid-credentials response as a wrong password, so a code cannot
 * be used to probe which Companies exist. No endpoint anywhere confirms a
 * Company name from a code alone; the first name disclosure is the dashboard
 * AFTER authentication succeeds.
 */
@Injectable()
export class CompanyMobileCodeResolver {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** Returns the Company subdomain for a mobile code, or undefined. */
  public async resolve(code: string | undefined): Promise<string | undefined> {
    const trimmed = code?.trim();
    if (trimmed === undefined || !/^[0-9]{6}$/.test(trimmed)) return undefined;
    const row = (
      await sql<{ subdomain: string }>`
        select subdomain from companies where mobile_code = ${trimmed} limit 1
      `.execute(this.database)
    ).rows[0];
    return row?.subdomain;
  }
}
