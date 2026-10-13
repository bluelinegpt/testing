import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationalJournalPostingService } from "./operational-journal-posting.service.js";
import type {
  OperationalAccountingEventRecord,
  OperationalJournalFacts,
} from "./operational-source.loader.js";

/**
 * A Driver Collection that moved no money (Lahthza REC-000091 / REC-000093,
 * 11 Oct 2026: one Order, COD 0, Trader pays the fee) produced an empty
 * Journal, failed as accounting_event_not_balanced, could not be cleared by
 * Reprocess and blocked the month-end close. It must now settle as
 * ignored_no_accounting_required -- and ONLY Driver Collections may do so.
 *
 * No database: a recording driver captures every statement and answers each
 * with the rows the test queues for it.
 */
function recordingDatabase(answer: (sqlText: string) => readonly Record<string, unknown>[] = () => []) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      return { rows: answer(query.sql) as R[] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error("not used");
    },
  };
  const driver: Driver = {
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    destroy: async () => undefined,
    init: async () => undefined,
    releaseConnection: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const database = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database, statements };
}

function event(overrides: Partial<OperationalAccountingEventRecord> = {}): OperationalAccountingEventRecord {
  return {
    actorId: "00000000-0000-0000-0000-0000000000a1",
    companyId: "00000000-0000-0000-0000-0000000000c1",
    correlationId: "corr-1",
    effectiveAccountingDate: "2026-10-11",
    eventHash: "hash",
    eventType: "driver_collection_confirmed",
    eventVersion: 1,
    id: "00000000-0000-0000-0000-0000000000e1",
    operationalArea: "driver_collections",
    reversalOfEventId: null,
    sourceEntityId: "00000000-0000-0000-0000-0000000000d1",
    sourceEntityType: "driver_reconciliation",
    sourceReference: "REC-000091",
    ...overrides,
  };
}

const emptyFacts: OperationalJournalFacts = {
  accountingDate: "2026-10-11",
  components: [],
  description: "Driver collection REC-000091",
  journalSource: "driver_collection" as OperationalJournalFacts["journalSource"],
  metadata: {},
  sourceReference: "REC-000091",
};

function service(facts: OperationalJournalFacts) {
  const audit = vi.fn(async () => undefined);
  const resolve = vi.fn(async () => []);
  const posting = new OperationalJournalPostingService(
    { resolve } as never,
    { load: vi.fn(async () => facts) } as never,
    { audit } as never,
  );
  return { audit, posting, resolve };
}

describe("OperationalJournalPostingService -- a Driver Collection that moved no money", () => {
  it("settles as ignored_no_accounting_required with an audit entry, and writes no Journal", async () => {
    const { database, statements } = recordingDatabase();
    const { audit, posting, resolve } = service(emptyFacts);

    await expect(posting.process(database, event())).resolves.toBeNull();

    expect(statements.some((s) => s.includes("ignored_no_accounting_required"))).toBe(true);
    expect(statements.some((s) => /insert into journal_entries/i.test(s))).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        action: "accounting.operational_event.no_accounting_required",
        subjectType: "accounting_event",
      }),
    );
  });

  it("does NOT take the shortcut for any other Event type with an empty source", async () => {
    const { database, statements } = recordingDatabase();
    const { posting } = service(emptyFacts);

    await expect(
      posting.process(
        database,
        event({ eventType: "order_delivered", operationalArea: "orders", sourceEntityType: "order" }),
      ),
    ).rejects.toThrow();
    expect(statements.some((s) => s.includes("ignored_no_accounting_required"))).toBe(false);
  });

  it("settles the reversal of a no-accounting Driver Collection the same way", async () => {
    const { database, statements } = recordingDatabase((sqlText) =>
      /select processing_status as status from accounting_events/i.test(sqlText)
        ? [{ status: "ignored_no_accounting_required" }]
        : [],
    );
    const { posting } = service(emptyFacts);

    await expect(
      posting.process(
        database,
        event({
          eventType: "driver_collection_reversed",
          id: "00000000-0000-0000-0000-0000000000e2",
          reversalOfEventId: "00000000-0000-0000-0000-0000000000e1",
        }),
      ),
    ).resolves.toBeNull();
    expect(statements.filter((s) => s.includes("ignored_no_accounting_required"))).toHaveLength(1);
    expect(statements.some((s) => /insert into journal_entries/i.test(s))).toBe(false);
  });
});
