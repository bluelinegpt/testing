import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import { type Caller, createCaller } from "./concurrency-harness.js";

/**
 * Trader Collection "Reverse & adjust" and "Post again" (Aiman, 20 Nov 2026).
 *
 * The case that asked for it: COL-000022 (Lahthza) collected four fees, one of
 * them 60 by mistake. Reversing the collection was possible; changing the fee
 * and posting the same fees again meant rebuilding the collection by hand.
 *
 * WRITES COMMITTED DATA (collections are immutable), so it is gated twice:
 * RUN_COLLECTION_REPOST_DATABASE=true, and DATABASE_URL must name the
 * throw-away database in BLUELINE_DISPOSABLE_DB_NAME. Never a real database.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_COLLECTION_REPOST_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

interface Fixture {
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly companyId: string;
  readonly traderId: string;
}

interface DraftPayload {
  readonly amount: number;
  readonly notes?: string;
  readonly receivableOffsets?: readonly { amount: number; receivableId: string }[];
}

describe.skipIf(!runDatabaseTests)("Trader Collection Reverse & adjust / Post again", () => {
  let admin: Pool;
  let fixture: Fixture;
  let caller: Caller;
  let orderSeq = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 2 });
    const companyId = randomUUID();
    const actorId = randomUUID();
    const cashAccountId = randomUUID();
    const traderId = randomUUID();
    const suffix = companyId.slice(0, 8);
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into companies (id, code, subdomain, name_en, status, activated_at, settlement_one_screen_enabled)
         values ($1, $2, $3, 'Collection Repost Company', 'active', now(), true)`,
        [companyId, `COLRP-${suffix}`, `colrp-${suffix}`],
      );
      await client.query(
        `insert into accounts (id, company_id, account_kind, username, password_hash)
         values ($1, $2, 'company_user', $3, 'test-only')`,
        [actorId, companyId, `colrp.actor.${suffix}`],
      );
      const roleId = randomUUID();
      await client.query(
        `insert into roles (id, company_id, code, name, is_system)
         values ($1, $2, 'company_admin', 'Company Administrator', true)`,
        [roleId, companyId],
      );
      await client.query(
        `insert into role_permissions (role_id, permission_code) values ($1, 'users_roles.manage')`,
        [roleId],
      );
      await client.query(
        `insert into account_roles (account_id, role_id, company_id) values ($1, $2, $3)`,
        [actorId, roleId, companyId],
      );
      await client.query(
        `insert into company_cash_accounts
           (id, company_id, cash_account_code, cash_account_name, cash_account_type, effective_from, is_active)
         values ($1, $2, 'CASH-01', 'Main Cash', 'main_cash', current_date - 365, true)`,
        [cashAccountId, companyId],
      );
      const traderAccountId = randomUUID();
      await client.query(
        `insert into accounts (id, company_id, account_kind, username, password_hash)
         values ($1, $2, 'trader', $3, 'test-only')`,
        [traderAccountId, companyId, `colrp.trader.${suffix}`],
      );
      await client.query(
        `insert into traders (id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
         values ($1, $2, $3, $4, 'Repost Trader', '971501234567', $5)`,
        [traderId, companyId, traderAccountId, `TRD-${suffix}`, actorId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    fixture = { actorId, cashAccountId, companyId, traderId };
    caller = createCaller(databaseUrl, companyId, actorId, { withTraderReceivables: true });
  }, 120_000);

  afterAll(async () => {
    await caller?.destroy();
    await admin?.end();
  });

  /** Four "Order service fee" charges, as Lahthza's COL-000022 had. */
  const fees = async (amounts: readonly number[]): Promise<{ id: string; order: string }[]> => {
    const created: { id: string; order: string }[] = [];
    for (const amount of amounts) {
      orderSeq += 1;
      const order = `ORD-RP-${fixture.companyId.slice(0, 4)}-${orderSeq}`;
      const result = await admin.query<{ id: string }>(
        `insert into trader_receivables (
           company_id, receivable_number, trader_id, source_type, source_reference,
           business_date, original_amount_due, amount_collected, status, reason, created_by_account_id)
         values ($1, $2, $3, 'service_charge', $4, current_date, $5, 0, 'outstanding',
                 'Order service fee owed by Trader', $6)
         returning id`,
        [fixture.companyId, `RCV-RP-${orderSeq}`, fixture.traderId, order, amount, fixture.actorId],
      );
      created.push({ id: result.rows[0]!.id, order });
    }
    return created;
  };

  const collect = async (lines: readonly { id: string; amount: number }[]) =>
    caller.traderReceivableService!.confirmCollection(
      {
        allocations: lines.map((line) => ({ amount: line.amount, receivableId: line.id })),
        amountReceived: lines.reduce((sum, line) => sum + line.amount, 0),
        paymentMethod: "cash",
        traderId: fixture.traderId,
      } as never,
      randomUUID(),
      `test-collect-${randomUUID()}`,
    );

  /** What Change fee does to a collected-then-reversed fee: cancel it, open a new one. */
  const changeFee = async (
    receivableId: string,
    order: string,
    amount: number,
  ): Promise<string> => {
    await admin.query(
      `update trader_receivables set status = 'cancelled', updated_at = now()
        where company_id = $1 and id = $2`,
      [fixture.companyId, receivableId],
    );
    orderSeq += 1;
    const created = await admin.query<{ id: string }>(
      `insert into trader_receivables (
         company_id, receivable_number, trader_id, source_type, source_reference,
         business_date, original_amount_due, amount_collected, status, reason, created_by_account_id)
       values ($1, $2, $3, 'service_charge', $4, current_date, $5, 0, 'outstanding',
               'Order service fee owed by Trader', $6)
       returning id`,
      [fixture.companyId, `RCV-RP-${orderSeq}`, fixture.traderId, order, amount, fixture.actorId],
    );
    return created.rows[0]!.id;
  };

  const draft = async (draftId: string) =>
    (
      await admin.query<{ payload: DraftPayload; replaces: string | null; status: string }>(
        `select payload, replaces_collection_id::text as replaces, status
           from trader_settlement_drafts where company_id = $1 and id = $2`,
        [fixture.companyId, draftId],
      )
    ).rows[0]!;

  const post = async (draftId: string) => {
    // The screen saves the draft with the cash account it shows, then posts.
    await admin.query(
      `update trader_settlement_drafts
          set payload = payload || jsonb_build_object('cashAccountId', $3::text)
        where company_id = $1 and id = $2`,
      [fixture.companyId, draftId, fixture.cashAccountId],
    );
    // Fee-only drafts post as a Trader Collection: the result carries it.
    return (await caller.traderSettlementService.confirmDraft(draftId, randomUUID())) as {
      readonly collectionId: string;
    };
  };

  const failure = async (operation: Promise<unknown>): Promise<string> => {
    try {
      await operation;
    } catch (error) {
      if (error instanceof ApplicationException) return error.errorCode;
      throw error;
    }
    throw new Error("expected the operation to be refused");
  };

  it("Reverse & adjust reverses the collection and opens its fees as a draft; Change fee, then post: the new collection replaces the old", async () => {
    const [a, b, c, d] = await fees([20, 20, 20, 60]);
    const original = await collect([
      { amount: 20, id: a!.id },
      { amount: 20, id: b!.id },
      { amount: 20, id: c!.id },
      { amount: 60, id: d!.id },
    ]);

    const result = await caller.traderSettlementService.unpostCollection(
      original.collectionId,
      "Fee on the Ruwais order was wrong",
      randomUUID(),
    );
    expect(result.settlementNumber).toBe(original.collectionNumber);
    expect(result.skippedReceivables).toEqual([]);

    const status = await admin.query<{ status: string }>(
      `select status from trader_collections where company_id = $1 and id = $2`,
      [fixture.companyId, original.collectionId],
    );
    expect(status.rows[0]?.status).toBe("reversed");
    const opened = await draft(result.draftId);
    expect(opened.status).toBe("draft");
    expect(opened.replaces).toBe(original.collectionId);
    expect(opened.payload.amount).toBe(-120);
    expect(opened.payload.notes).toContain(original.collectionNumber);
    expect(new Set(opened.payload.receivableOffsets?.map((line) => line.receivableId))).toEqual(
      new Set([a!.id, b!.id, c!.id, d!.id]),
    );

    // Change fee on the fourth Order (60 -> 40), then point the draft at the
    // new fee, as Change fee does for an open draft.
    const replacementFee = await changeFee(d!.id, d!.order, 40);
    await admin.query(
      `update trader_settlement_drafts
          set payload = jsonb_set(payload, '{receivableOffsets}',
                (select jsonb_agg(case when line ->> 'receivableId' = $3
                                       then jsonb_build_object('receivableId', $4::text, 'amount', 40)
                                       else line end)
                   from jsonb_array_elements(payload -> 'receivableOffsets') line))
        where company_id = $1 and id = $2`,
      [fixture.companyId, result.draftId, d!.id, replacementFee],
    );

    const posted = await post(result.draftId);
    expect(posted.collectionId).toBeTruthy();
    const replaced = await admin.query<{ amount: string; replaces: string | null }>(
      `select amount_received::text as amount, replaces_collection_id::text as replaces
         from trader_collections where company_id = $1 and id = $2`,
      [fixture.companyId, posted.collectionId],
    );
    expect(replaced.rows[0]).toEqual({ amount: "100.00", replaces: original.collectionId });

    const oldDetail = await caller.traderReceivableService!.detail(original.collectionId);
    expect(oldDetail.replacedBy.map((link) => link.collectionId)).toEqual([posted.collectionId]);
    const newDetail = await caller.traderReceivableService!.detail(posted.collectionId);
    expect(newDetail.replaces?.collectionNumber).toBe(original.collectionNumber);

    // Already replaced: Post again is refused and names the replacement.
    expect(
      await failure(
        caller.traderSettlementService.repostCollection(original.collectionId, randomUUID()),
      ),
    ).toBe("trader_collection_already_replaced");
  }, 60_000);

  it("Post again opens a reversed collection's fees as a draft, taking a changed fee at its new amount and leaving out one collected since", async () => {
    const [a, b, c] = await fees([20, 25, 60]);
    const original = await collect([
      { amount: 20, id: a!.id },
      { amount: 25, id: b!.id },
      { amount: 60, id: c!.id },
    ]);
    await caller.traderReceivableService!.reverseCollection(
      original.collectionId,
      "plain reverse",
      randomUUID(),
    );

    // Since the reversal: fee c changed to 40, and fee b was collected again.
    const replacementFee = await changeFee(c!.id, c!.order, 40);
    await collect([{ amount: 25, id: b!.id }]);

    const result = await caller.traderSettlementService.repostCollection(
      original.collectionId,
      randomUUID(),
    );
    expect(result.collectionNumber).toBe(original.collectionNumber);
    expect(result.skippedReceivables).toEqual(["RCV-RP-" + String(orderSeq - 2)]);
    const opened = await draft(result.draftId);
    expect(opened.replaces).toBe(original.collectionId);
    expect(opened.payload.receivableOffsets).toEqual(
      expect.arrayContaining([
        { amount: 20, receivableId: a!.id },
        { amount: 40, receivableId: replacementFee },
      ]),
    );
    expect(opened.payload.receivableOffsets).toHaveLength(2);
    expect(opened.payload.amount).toBe(-60);

    // Pressed again: the same draft, not a second one.
    const again = await caller.traderSettlementService.repostCollection(
      original.collectionId,
      randomUUID(),
    );
    expect(again.draftId).toBe(result.draftId);

    // A confirmed collection cannot be "posted again"; a reversed one cannot be reversed again.
    const posted = await post(result.draftId);
    expect(
      await failure(
        caller.traderSettlementService.repostCollection(posted.collectionId, randomUUID()),
      ),
    ).toBe("trader_collection_not_reversed");
    expect(
      await failure(
        caller.traderSettlementService.unpostCollection(
          original.collectionId,
          "twice",
          randomUUID(),
        ),
      ),
    ).toBe("trader_collection_already_reversed");
  }, 60_000);

  it("a collection posted from a one-screen draft is un-posted through its draft, and the reopened draft remembers it", async () => {
    const [a, b] = await fees([15, 35]);
    const fromScreen = await admin.query<{ id: string }>(
      `insert into trader_settlement_drafts (company_id, trader_id, payload, created_by_account_id, updated_by_account_id)
       values ($1, $2, $3, $4, $4) returning id`,
      [
        fixture.companyId,
        fixture.traderId,
        JSON.stringify({
          allocations: [],
          amount: -50,
          paymentMethod: "cash",
          receivableOffsets: [
            { amount: 15, receivableId: a!.id },
            { amount: 35, receivableId: b!.id },
          ],
          traderId: fixture.traderId,
        }),
        fixture.actorId,
      ],
    );
    const posted = await post(fromScreen.rows[0]!.id);
    const result = await caller.traderSettlementService.unpostCollection(
      posted.collectionId,
      "adjust",
      randomUUID(),
    );
    expect(result.draftId).not.toBe(fromScreen.rows[0]!.id);
    const reopened = await draft(result.draftId);
    expect(reopened.replaces).toBe(posted.collectionId);
    expect(reopened.payload.amount).toBe(-50);
    const old = await draft(fromScreen.rows[0]!.id);
    expect(old.status).toBe("confirmed");
    await admin.query(`delete from trader_settlement_drafts where company_id = $1 and id = $2`, [
      fixture.companyId,
      result.draftId,
    ]);
  }, 60_000);

  it("refuses while the Trader has another open draft, and when nothing on the collection is still owed", async () => {
    const [a] = await fees([30]);
    const original = await collect([{ amount: 30, id: a!.id }]);
    const other = await admin.query<{ id: string }>(
      `insert into trader_settlement_drafts (company_id, trader_id, payload, created_by_account_id, updated_by_account_id)
       values ($1, $2, $3, $4, $4) returning id`,
      [
        fixture.companyId,
        fixture.traderId,
        JSON.stringify({ allocations: [], amount: 0, traderId: fixture.traderId }),
        fixture.actorId,
      ],
    );
    expect(
      await failure(
        caller.traderSettlementService.unpostCollection(original.collectionId, "x", randomUUID()),
      ),
    ).toBe("trader_settlement_draft_already_open");
    // Refused as a whole: the collection was not reversed.
    const still = await admin.query<{ status: string }>(
      `select status from trader_collections where company_id = $1 and id = $2`,
      [fixture.companyId, original.collectionId],
    );
    expect(still.rows[0]?.status).toBe("confirmed");
    await admin.query(`delete from trader_settlement_drafts where company_id = $1 and id = $2`, [
      fixture.companyId,
      other.rows[0]!.id,
    ]);

    await caller.traderReceivableService!.reverseCollection(
      original.collectionId,
      "reverse",
      randomUUID(),
    );
    await admin.query(
      `update trader_receivables set status = 'cancelled', updated_at = now() where company_id = $1 and id = $2`,
      [fixture.companyId, a!.id],
    );
    expect(
      await failure(
        caller.traderSettlementService.repostCollection(original.collectionId, randomUUID()),
      ),
    ).toBe("trader_collection_nothing_to_repost");
  }, 60_000);
});
