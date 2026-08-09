import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { AccountingFoundationService } from "./accounting-foundation.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { FiscalCalendarService } from "./fiscal-calendar.service.js";
import { OpeningBalanceService } from "./opening-balance.service.js";

/**
 * Deleting a Draft Opening Balance Batch.
 *
 * A Draft has produced nothing — no Journal, no Accounting Event, no ledger
 * movement — so removing it is not a financial act, and an abandoned Draft is
 * not free: it counts as a Period close blocker forever. These cases prove the
 * delete is safe rather than assuming it: that the row and its Lines go, that
 * the audit outlives them, that nothing financial appears, that every status
 * past Draft refuses, and that the close blocker clears at its source.
 *
 * Only a real database can answer these. The deletion is governed by an
 * `on delete restrict` foreign key and two PL/pgSQL triggers, and "no Journal
 * was written" is a claim about tables. Every case runs inside one transaction
 * that is rolled back.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `obdel_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

class MutableIdentity {
  public permissions: Set<string>;
  public constructor(
    public companyId: string,
    public actorId: string,
    permissions: readonly string[],
  ) {
    this.permissions = new Set(permissions);
  }
  public current() {
    return {
      companyId: this.companyId,
      forcePasswordChange: false,
      identityId: this.actorId,
      kind: "company_user" as const,
      permissions: this.permissions,
      sessionId: randomUUID(),
    };
  }
}

interface Company {
  readonly actorId: string;
  readonly approverId: string;
  readonly bankGl: string;
  readonly companyId: string;
  readonly equityGl: string;
  readonly periodId: string;
}

function connect(): Kysely<DatabaseSchema> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

/** One connection per case, one transaction, always rolled back. */
async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = connect();
  const marker = new Error("rollback opening balance delete test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    // destroy() ends the underlying pool; calling pool.end() as well throws.
    await database.destroy();
  }
}

/** One Company with an open Period and the two posting Accounts a Batch needs. */
async function seedCompany(
  transaction: Transaction<DatabaseSchema>,
  label: string,
): Promise<Company> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const approverId = randomUUID();
  const fiscalYearId = randomUUID();
  const periodId = randomUUID();
  const bankGl = randomUUID();
  const equityGl = randomUUID();
  const short = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Opening Balance Delete Test','active',now())`.execute(transaction);
  for (const id of [actorId, approverId]) {
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
      values(${id}::uuid,${companyId}::uuid,'company_user',${`ob.${id}`},'x')`.execute(transaction);
  }
  await sql`insert into fiscal_years(
      id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
    ) values(${fiscalYearId}::uuid,${companyId}::uuid,'FY-2026','FY 2026',
      '2026-01-01'::date,'2026-12-31'::date,'open',${actorId}::uuid)`.execute(transaction);
  await sql`insert into accounting_periods(
      id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
    ) values(${periodId}::uuid,${companyId}::uuid,${fiscalYearId}::uuid,'P01','January 2026',1,
      '2026-01-01'::date,'2026-01-31'::date,'open')`.execute(transaction);
  await sql`insert into chart_of_accounts(
      id,company_id,code,name_en,account_type,account_class,normal_balance,
      is_posting_account,is_active
    ) values
      (${bankGl}::uuid,${companyId}::uuid,'1010','Main Bank','asset','bank','debit',true,true),
      (${equityGl}::uuid,${companyId}::uuid,'3020','Owner Equity','equity','owner_equity','credit',
       true,true)`.execute(transaction);
  return { actorId, approverId, bankGl, companyId, equityGl, periodId };
}

function services(transaction: Transaction<DatabaseSchema>, identity: MutableIdentity) {
  const tenants = {
    current: () => ({ companyId: identity.companyId, identityId: identity.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = identity as unknown as IdentityContextAccessor;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  const history = new OperationsHistoryWriter();
  const support = new AccountingOperationSupport(tenants, identities, history);
  const foundation = new AccountingFoundationService(
    transaction as unknown as Kysely<DatabaseSchema>,
    manager,
    history,
    tenants,
    identities,
  );
  return {
    balances: new OpeningBalanceService(manager, support, foundation),
    calendar: new FiscalCalendarService(manager, support),
  };
}

const permissions = [
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.post",
  "accounting.reverse",
  "accounting.periods",
];

describe.skipIf(!runDatabaseTests)("opening balance draft delete", () => {
  /** Balanced Lines, so `create` validates the Batch outright. */
  const createValidatedBatch = async (
    transaction: Transaction<DatabaseSchema>,
    company: Company,
    identity: MutableIdentity,
  ): Promise<string> => {
    const created = (await services(transaction, identity).balances.create(
      {
        currency: "AED",
        description: "Opening position",
        effectiveDate: "2026-01-01",
        lines: [
          { accountId: company.bankGl, credit: 0, debit: 20000, lineNumber: 1 },
          { accountId: company.equityGl, credit: 20000, debit: 0, lineNumber: 2 },
        ],
      } as never,
      randomUUID(),
    )) as Record<string, unknown>;
    return String(created.id);
  };

  /** A Batch parked in Draft, via the existing Return to draft transition. */
  const createDraftBatch = async (
    transaction: Transaction<DatabaseSchema>,
    company: Company,
    identity: MutableIdentity,
  ): Promise<string> => {
    const batchId = await createValidatedBatch(transaction, company, identity);
    await services(transaction, identity).balances.returnToDraft(
      batchId,
      "Abandoning",
      randomUUID(),
    );
    return batchId;
  };

  const counts = async (transaction: Transaction<DatabaseSchema>, companyId: string) => {
    const row = await sql<{
      batches: string;
      events: string;
      journalLines: string;
      journals: string;
      lines: string;
    }>`
      select
        (select count(*)::text from opening_balance_batches where company_id=${companyId}::uuid)
          as batches,
        (select count(*)::text from opening_balance_lines where company_id=${companyId}::uuid)
          as lines,
        (select count(*)::text from journal_entries where company_id=${companyId}::uuid)
          as journals,
        (select count(*)::text from journal_lines where company_id=${companyId}::uuid)
          as "journalLines",
        (select count(*)::text from accounting_events where company_id=${companyId}::uuid)
          as events
    `.execute(transaction);
    return row.rows[0]!;
  };

  it("deletes a draft batch and its lines together", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODA");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);

      const before = await counts(transaction, company.companyId);
      expect(before.batches).toBe("1");
      expect(before.lines).toBe("2");

      const result = (await services(transaction, identity).balances.remove(
        batchId,
        "No longer needed",
      )) as Record<string, unknown>;
      expect(result.deleted).toBe(true);

      const after = await counts(transaction, company.companyId);
      // `opening_balance_lines_batch_fk` is `on delete restrict`, so a Batch
      // that still had Lines could not have been removed at all.
      expect(after.batches).toBe("0");
      expect(after.lines).toBe("0");
    });
  });

  it("creates no journal, no journal line and no accounting event", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODB");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);
      await services(transaction, identity).balances.remove(batchId, "Nothing posted");

      const after = await counts(transaction, company.companyId);
      expect(after.journals).toBe("0");
      expect(after.journalLines).toBe("0");
      expect(after.events).toBe("0");
    });
  });

  it("leaves no ledger movement on any account", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODC");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);
      await services(transaction, identity).balances.remove(batchId, "Nothing posted");

      /* The GL, Trial Balance, Cashbook and Bank Ledger are all read from
         posted journal_lines. No line for these Accounts means no impact on
         any of them. */
      const movement = await sql<{ credit: string; debit: string }>`
        select coalesce(sum(l.debit),0)::text as debit, coalesce(sum(l.credit),0)::text as credit
          from journal_lines l
          join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${company.companyId}::uuid
           and l.account_id in (${company.bankGl}::uuid, ${company.equityGl}::uuid)
      `.execute(transaction);
      expect(movement.rows[0]!.debit).toBe("0");
      expect(movement.rows[0]!.credit).toBe("0");
    });
  });

  it("records what was deleted in an audit event that outlives the batch", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODD");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);
      const batchNumber = await sql<{ batchNumber: string }>`
        select batch_number as "batchNumber" from opening_balance_batches
         where id=${batchId}::uuid`.execute(transaction);

      await services(transaction, identity).balances.remove(batchId, "Duplicate entry");

      // `audit_events.subject_id` is text with no foreign key, so the row
      // survives the deletion of the record it describes.
      const audit = await sql<{ actor: string | null; after: Record<string, unknown> }>`
        select after_data as after, actor_account_id as actor from audit_events
         where company_id=${company.companyId}::uuid
           and action='accounting.opening_balance.deleted'
           and subject_id=${batchId}`.execute(transaction);
      expect(audit.rows).toHaveLength(1);
      const recorded = audit.rows[0]!.after;
      expect(recorded.batchNumber).toBe(batchNumber.rows[0]!.batchNumber);
      expect(recorded.effectiveDate).toBe("2026-01-01");
      expect(recorded.currency).toBe("AED");
      expect(recorded.totalDebit).toBe("20000.00");
      expect(recorded.totalCredit).toBe("20000.00");
      expect(recorded.description).toBe("Opening position");
      expect(recorded.status).toBe("draft");
      expect(recorded.lineCount).toBe("2");
      expect(recorded.reason).toBe("Duplicate entry");
      expect(recorded.deletedAt).toEqual(expect.any(String));
      expect(audit.rows[0]!.actor).toBe(company.actorId);
    });
  });

  it("stops returning the deleted batch from detail and list", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODE");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);
      const balances = services(transaction, identity).balances;
      await balances.remove(batchId, "Gone");

      await expect(balances.detail(batchId)).rejects.toMatchObject({
        errorCode: "accounting_opening_balance_not_found",
      });
      const listed = (await balances.list({} as never)) as { readonly items: readonly unknown[] };
      expect(listed.items).toHaveLength(0);
    });
  });

  it("refuses every status past draft", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODF");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const approver = new MutableIdentity(company.companyId, company.approverId, permissions);

      // validated
      const validated = await createValidatedBatch(transaction, company, identity);
      await expect(
        services(transaction, identity).balances.remove(validated, "no"),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_deletable" });

      // approved
      await services(transaction, approver).balances.approve(validated, "ok", randomUUID());
      await expect(
        services(transaction, identity).balances.remove(validated, "no"),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_deletable" });

      // posted
      await services(transaction, identity).balances.post(validated, "ok", randomUUID());
      await expect(
        services(transaction, identity).balances.remove(validated, "no"),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_deletable" });

      // reversed
      await services(transaction, approver).balances.reverse(
        validated,
        { reason: "Wrong figures", reversalDate: "2026-01-15" } as never,
        randomUUID(),
      );
      await expect(
        services(transaction, identity).balances.remove(validated, "no"),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_deletable" });

      // The Batch and both its Journals are still there, untouched.
      const after = await counts(transaction, company.companyId);
      expect(after.batches).toBe("1");
      expect(after.journals).toBe("2");
    });
  });

  it("refuses a draft that unexpectedly carries a journal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODG");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);
      /* A Draft with a Journal means an invariant is already broken elsewhere.
         Deleting is the wrong response, so the guard is on the relationship
         and not on status alone. Written directly: no service path can
         produce this state. */
      const journalId = randomUUID();
      await sql`
        insert into journal_entries (
          id, company_id, journal_number, accounting_period_id, fiscal_year_id,
          business_date, journal_type, source_type, source_id, description,
          currency, exchange_rate, status, source_entity_type, source_entity_id,
          created_by_account_id, updated_by_account_id
        )
        select ${journalId}::uuid, ${company.companyId}::uuid, 'JRN-STRAY',
               accounting_period_id, fiscal_year_id, effective_date, 'opening_balance',
               'opening_balance', ${batchId}::uuid, 'Stray', 'AED', 1, 'draft',
               'opening_balance', ${batchId}::uuid,
               ${company.actorId}::uuid, ${company.actorId}::uuid
          from opening_balance_batches
         where id=${batchId}::uuid and company_id=${company.companyId}::uuid
      `.execute(transaction);

      await expect(
        services(transaction, identity).balances.remove(batchId, "try"),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_deletable" });
      expect((await counts(transaction, company.companyId)).batches).toBe("1");
    });
  });

  it("requires accounting.manage", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODH");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);

      const viewer = new MutableIdentity(company.companyId, company.actorId, [
        "accounting.view",
        "accounting.approve",
        "accounting.post",
      ]);
      await expect(
        services(transaction, viewer).balances.remove(batchId, "no rights"),
      ).rejects.toBeTruthy();
      expect((await counts(transaction, company.companyId)).batches).toBe("1");
    });
  });

  it("cannot delete a batch belonging to another Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seedCompany(transaction, "ODI");
      const neighbour = await seedCompany(transaction, "ODJ");
      const ownerIdentity = new MutableIdentity(owner.companyId, owner.actorId, permissions);
      const batchId = await createDraftBatch(transaction, owner, ownerIdentity);

      const intruder = new MutableIdentity(neighbour.companyId, neighbour.actorId, permissions);
      await expect(
        services(transaction, intruder).balances.remove(batchId, "not mine"),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_found" });
      expect((await counts(transaction, owner.companyId)).batches).toBe("1");
    });
  });

  it("clears the draft opening balance close blocker at its source", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "ODK");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createDraftBatch(transaction, company, identity);
      const { balances, calendar } = services(transaction, identity);

      const blocked = await calendar.periodDependencies(company.periodId, transaction);
      expect(JSON.stringify(blocked.blockingIssues)).toContain("draft_opening_balances");

      await balances.remove(batchId, "Abandoned");

      /* The blocker clears because the record is gone, not because the check
         was weakened — `fiscal-calendar.service.ts` is untouched. */
      const clear = await calendar.periodDependencies(company.periodId, transaction);
      expect(JSON.stringify(clear.blockingIssues)).not.toContain("draft_opening_balances");
    });
  });
});
