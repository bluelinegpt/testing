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
import { OpeningBalanceService } from "./opening-balance.service.js";

/**
 * The Opening Balance validated -> draft transition.
 *
 * The demotion itself was always in the service — `makeEditable` performs it on
 * every edit of a validated Batch, and both Batch triggers whitelist the pair —
 * but it had no action of its own, so a Batch that was validated and never
 * approved could only go forward. These cases pin the explicit path: that it
 * works from `validated`, that it is refused everywhere else, that it costs
 * nothing financially, and that it cannot reach across Companies.
 *
 * Only a real database can answer these: the immutability and transition
 * triggers are PL/pgSQL, and "no Journal was written" is a claim about tables.
 * Every case runs inside one transaction that is rolled back.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `obrtd_${++this.sequence}`;
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
  const marker = new Error("rollback opening balance return to draft test");
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
      'Opening Balance Return Test','active',now())`.execute(transaction);
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
  return { actorId, approverId, bankGl, companyId, equityGl };
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
  return new OpeningBalanceService(manager, support, foundation);
}

const permissions = [
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.post",
];

describe.skipIf(!runDatabaseTests)("opening balance return to draft", () => {
  /** A balanced Batch. `create` validates it outright when the Lines balance. */
  const createValidatedBatch = async (
    transaction: Transaction<DatabaseSchema>,
    company: Company,
    identity: MutableIdentity,
  ): Promise<string> => {
    const balances = services(transaction, identity);
    const created = (await balances.create(
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

  const statusOf = async (transaction: Transaction<DatabaseSchema>, batchId: string) => {
    const row = await sql<{
      journalId: string | null;
      status: string;
      totalCredit: string;
      totalDebit: string;
      validatedAt: Date | null;
    }>`select status, journal_id as "journalId", validated_at as "validatedAt",
             total_debit::text as "totalDebit", total_credit::text as "totalCredit"
         from opening_balance_batches where id=${batchId}::uuid`.execute(transaction);
    return row.rows[0]!;
  };

  it("validates a balanced batch on create, then returns it to draft on request", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBA");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);

      const before = await statusOf(transaction, batchId);
      expect(before.status).toBe("validated");
      expect(before.validatedAt).not.toBeNull();

      await services(transaction, identity).returnToDraft(batchId, "Wrong equity account", randomUUID());

      const after = await statusOf(transaction, batchId);
      expect(after.status).toBe("draft");
      // The validation stamp is cleared; the money is not touched.
      expect(after.validatedAt).toBeNull();
      expect(after.totalDebit).toBe("20000.00");
      expect(after.totalCredit).toBe("20000.00");
    });
  });

  it("creates no Journal, no Accounting Event and no reversal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBB");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);
      await services(transaction, identity).returnToDraft(batchId, "Abandoning", randomUUID());

      const journals = await sql<{ count: string }>`
        select count(*)::text as count from journal_entries
         where company_id=${company.companyId}::uuid`.execute(transaction);
      const lines = await sql<{ count: string }>`
        select count(*)::text as count from journal_lines
         where company_id=${company.companyId}::uuid`.execute(transaction);
      const events = await sql<{ count: string }>`
        select count(*)::text as count from accounting_events
         where company_id=${company.companyId}::uuid`.execute(transaction);
      const batch = await statusOf(transaction, batchId);

      expect(journals.rows[0]!.count).toBe("0");
      expect(lines.rows[0]!.count).toBe("0");
      expect(events.rows[0]!.count).toBe("0");
      // Nothing was posted, so nothing is reversed and no Journal is linked.
      expect(batch.journalId).toBeNull();
    });
  });

  it("refuses a batch that is already draft", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBC");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);
      const balances = services(transaction, identity);
      await balances.returnToDraft(batchId, "First", randomUUID());

      await expect(balances.returnToDraft(batchId, "Second", randomUUID())).rejects.toMatchObject({
        errorCode: "accounting_opening_balance_not_returnable",
      });
    });
  });

  it("refuses an approved batch, leaving approved immutability intact", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBD");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);
      // Approval is segregated from creation, so a second actor approves.
      const approver = new MutableIdentity(company.companyId, company.approverId, permissions);
      await services(transaction, approver).approve(batchId, "Approved", randomUUID());

      await expect(
        services(transaction, identity).returnToDraft(batchId, "Too late", randomUUID()),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_returnable" });
      expect((await statusOf(transaction, batchId)).status).toBe("approved");
    });
  });

  it("refuses a posted batch and leaves its Journal untouched", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBE");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);
      const approver = new MutableIdentity(company.companyId, company.approverId, permissions);
      await services(transaction, approver).approve(batchId, "Approved", randomUUID());
      // Posting is segregated from approval, so the creator posts.
      await services(transaction, identity).post(batchId, "Posted", randomUUID());

      const posted = await statusOf(transaction, batchId);
      expect(posted.status).toBe("posted");
      expect(posted.journalId).not.toBeNull();

      await expect(
        services(transaction, identity).returnToDraft(batchId, "Undo", randomUUID()),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_returnable" });

      const after = await statusOf(transaction, batchId);
      expect(after.status).toBe("posted");
      expect(after.journalId).toBe(posted.journalId);
      const journals = await sql<{ count: string; status: string }>`
        select count(*)::text as count, max(status) as status from journal_entries
         where company_id=${company.companyId}::uuid`.execute(transaction);
      expect(journals.rows[0]!.count).toBe("1");
      expect(journals.rows[0]!.status).toBe("posted");
    });
  });

  it("requires accounting.manage", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBF");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);

      // A viewer, and an approver who cannot manage, are both refused.
      const viewer = new MutableIdentity(company.companyId, company.actorId, [
        "accounting.view",
        "accounting.approve",
      ]);
      await expect(
        services(transaction, viewer).returnToDraft(batchId, "No rights", randomUUID()),
      ).rejects.toBeTruthy();
      expect((await statusOf(transaction, batchId)).status).toBe("validated");
    });
  });

  it("cannot reach a batch belonging to another Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seedCompany(transaction, "OBG");
      const neighbour = await seedCompany(transaction, "OBH");
      const ownerIdentity = new MutableIdentity(owner.companyId, owner.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, owner, ownerIdentity);

      const intruder = new MutableIdentity(neighbour.companyId, neighbour.actorId, permissions);
      await expect(
        services(transaction, intruder).returnToDraft(batchId, "Not mine", randomUUID()),
      ).rejects.toMatchObject({ errorCode: "accounting_opening_balance_not_found" });
      expect((await statusOf(transaction, batchId)).status).toBe("validated");
    });
  });

  it("records the demotion in the audit trail", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBI");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);
      await services(transaction, identity).returnToDraft(batchId, "Wrong amount", randomUUID());

      const audits = await sql<{ count: string }>`
        select count(*)::text as count from audit_events
         where company_id=${company.companyId}::uuid
           and action='accounting.opening_balance.returned_to_draft'
           and subject_id=${batchId}`.execute(transaction);
      expect(audits.rows[0]!.count).toBe("1");
    });
  });

  it("lets a returned batch be validated again", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "OBJ");
      const identity = new MutableIdentity(company.companyId, company.actorId, permissions);
      const batchId = await createValidatedBatch(transaction, company, identity);
      const balances = services(transaction, identity);
      await balances.returnToDraft(batchId, "Recheck", randomUUID());
      expect((await statusOf(transaction, batchId)).status).toBe("draft");

      // draft -> validated, the transition this action undoes, still works.
      await balances.validate(batchId);
      const revalidated = await statusOf(transaction, batchId);
      expect(revalidated.status).toBe("validated");
      expect(revalidated.validatedAt).not.toBeNull();
      expect(revalidated.totalDebit).toBe("20000.00");
    });
  });
});
