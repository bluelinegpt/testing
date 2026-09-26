import { randomUUID } from "node:crypto";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext } from "../security/identity-context.js";
import type { TenantContext } from "../tenancy/tenant-context.js";

import { OperationsService } from "./operations.service.js";

/**
 * The searchable Trader Orders list and CSV bulk import (Trader Workspace
 * Prompt 3T-B).
 *
 * ---------------------------------------------------------------------------
 * THE TWO FAILURES THIS FILE GUARDS AGAINST
 * ---------------------------------------------------------------------------
 *
 * 1. `traderPortalOrdersPage` delegates to the Company `orders()` engine,
 *    whose row shape carries `companyRevenue`, `orderProfit`,
 *    `traderNetPayable` and Driver identity unconditionally. Forgetting the
 *    redaction step would leak all of that to a Trader's browser even though
 *    the UI never renders it.
 * 2. `createTraderPortalOrdersImport` rewrites the CSV to force every row's
 *    Trader. A regression here — trusting a `traderId` column the file
 *    already supplies — would let a Trader import Orders under another
 *    Trader's identity.
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const rollback = Symbol("rollback trader portal orders test");
  try {
    await database.transaction().execute(async (transaction) => {
      await work(transaction);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await database.destroy();
  }
}

async function seedTrader(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly company?: { readonly actorId: string; readonly companyId: string } } = {},
) {
  const companyId = input.company?.companyId ?? randomUUID();
  const actorId = input.company?.actorId ?? randomUUID();
  const accountId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();

  if (input.company === undefined) {
    await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
      values(${companyId}::uuid, ${`TO-${companyId.slice(0, 8)}`}, ${`to-${companyId.slice(0, 8)}`},
             'Trader Orders Test', 'active', now())`.execute(transaction);
    await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
      values (${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`to.a.${actorId}`}, 'x', 'en')`.execute(
      transaction,
    );
  }
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
    values (${accountId}::uuid, ${companyId}::uuid, 'trader', ${`to.t.${accountId}`}, 'x', 'en')`.execute(
    transaction,
  );
  await sql`insert into traders(id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
    values(${traderId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`TRD-${traderId.slice(0, 6)}`},
           'Orders Trader', '971501234567', ${actorId}::uuid)`.execute(transaction);
  await sql`insert into user_business_links(id, company_id, account_id, entity_type, entity_id, access_status, created_by_account_id)
    values(${randomUUID()}::uuid, ${companyId}::uuid, ${accountId}::uuid, 'trader', ${traderId}::uuid, 'active', ${actorId}::uuid)`.execute(
    transaction,
  );
  const dubai = (
    await sql<{ id: string }>`select id from emirates where code = 'DXB'`.execute(transaction)
  ).rows[0]!.id;
  await sql`insert into areas(id, company_id, emirate_id, code, name_en)
    values(${areaId}::uuid, ${companyId}::uuid, ${dubai}::uuid, ${`AREA-${areaId.slice(0, 6)}`},
           ${`Deira ${areaId.slice(0, 6)}`})`.execute(transaction);

  return { accountId, actorId, areaId, companyId, traderId };
}

async function seedOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: {
    readonly actorId: string;
    readonly areaId: string;
    readonly companyId: string;
    readonly traderId: string;
  },
  reference: string,
) {
  await sql`insert into orders(
      service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
      created_by_account_id, customer_name, customer_mobile_number, customer_address,
      reference_number, reference_number_normalized, package_count, payment_condition,
      final_service_fee_snapshot, customer_provenance_status, pricing_provenance_status,
      trader_gross_payable, trader_net_payable, cod_amount, customer_amount_due, delivery_status,
      driver_reconciliation_status, trader_settlement_status, return_status
    ) values (
      'Zero configured Service Fee (fixture)', ${randomUUID()}::uuid, ${fixture.companyId}::uuid,
      ${`ORD-${randomUUID().slice(0, 8)}`}, current_date, ${fixture.traderId}::uuid,
      ${fixture.areaId}::uuid, ${fixture.actorId}::uuid, 'Dev Customer', '971509990000',
      'Deira, Dubai', ${reference}, ${reference.toLowerCase()}, 1, 'customer_pays_cod_and_fee', 0,
      'legacy_unattributed', 'legacy_unattributed', 100.00, 100.00, 100.00, 100.00,
      'new', 'not_applicable', 'unsettled', 'not_applicable'
    )`.execute(transaction);
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly accountId: string; readonly companyId: string; readonly traderId: string },
): OperationsService {
  // Mirrors `AsyncTenantContextAccessor.run()`'s real contract closely enough
  // for these sequential tests: `run()` genuinely swaps what `current()`
  // returns for the duration of `work()`, then restores it — the same
  // "override the write's Company without touching the session" mechanism
  // `resolveTraderPortalDeliveryCompany` relies on in production.
  let activeTenant: TenantContext = { companyId: input.companyId, identityId: input.accountId };
  const tenants = {
    current: (): TenantContext => activeTenant,
    run: async <T>(context: TenantContext, work: () => Promise<T>): Promise<T> => {
      const previous = activeTenant;
      activeTenant = context;
      try {
        return await work();
      } finally {
        activeTenant = previous;
      }
    },
  };
  const identities = {
    current: (): IdentityContext => ({
      companyId: input.companyId,
      forcePasswordChange: false,
      identityId: input.accountId,
      kind: "trader",
      permissions: new Set<string>(),
      profileId: input.traderId,
      profileType: "trader",
      sessionId: "test-session",
    }),
  };
  const transactions = {
    execute: async <T>(work: (tx: Transaction<DatabaseSchema>) => Promise<T>) => work(transaction),
  };
  return new OperationsService(
    transaction as unknown as Kysely<DatabaseSchema>,
    transactions as unknown as KyselyTransactionManager,
    tenants as never,
    undefined as never,
    undefined as never,
    identities as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    new OperationsHistoryWriter(new WhatsAppOutboxWriter()),
  );
}

/**
 * Same as `buildService`, except `transactions.execute` is the REAL
 * `KyselyTransactionManager` (a genuine `transaction().execute()` -- Kysely
 * nests this as a SAVEPOINT when `transaction` is already inside one, which
 * it always is here, per `inRolledBackTransaction`). `buildService`'s own
 * `transactions` fake is a bare passthrough with no transactional boundary
 * of its own, which is fine for every test that only checks the FINAL rows
 * written -- but it cannot prove that a mid-import failure rolls back rows
 * already inserted earlier in the same batch, because there is no savepoint
 * to roll back to. Use this helper specifically for that proof (T9 §32/33).
 */
function buildServiceWithRealTransactions(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly accountId: string; readonly companyId: string; readonly traderId: string },
): OperationsService {
  let activeTenant: TenantContext = { companyId: input.companyId, identityId: input.accountId };
  const tenants = {
    current: (): TenantContext => activeTenant,
    run: async <T>(context: TenantContext, work: () => Promise<T>): Promise<T> => {
      const previous = activeTenant;
      activeTenant = context;
      try {
        return await work();
      } finally {
        activeTenant = previous;
      }
    },
  };
  const identities = {
    current: (): IdentityContext => ({
      companyId: input.companyId,
      forcePasswordChange: false,
      identityId: input.accountId,
      kind: "trader",
      permissions: new Set<string>(),
      profileId: input.traderId,
      profileType: "trader",
      sessionId: "test-session",
    }),
  };
  return new OperationsService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new KyselyTransactionManager(transaction as unknown as Kysely<DatabaseSchema>),
    tenants as never,
    undefined as never,
    undefined as never,
    identities as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    new OperationsHistoryWriter(new WhatsAppOutboxWriter()),
  );
}

describe.skipIf(!runDatabaseTests)("Trader portal Orders list", () => {
  it("redacts Company financial and Driver internals from every row", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      await seedOrder(transaction, fixture, "REF-0001");
      const service = buildService(transaction, fixture);

      const page = await service.traderPortalOrdersPage({});

      expect(page.items).toHaveLength(1);
      const row = page.items[0] as unknown as Record<string, unknown>;
      for (const sensitive of [
        "companyRevenue",
        "orderProfit",
        "traderNetPayable",
        "assignedDriverId",
        "assignedDriverName",
        "assignedDriverMobile",
        "accountingEventId",
        "accountingJournalId",
        "outsourcedDriverFeeAmount",
      ]) {
        expect(row).not.toHaveProperty(sensitive);
      }
      // What IS present is exactly the safe allow-list.
      expect(row.orderNumber).toBeDefined();
      expect(row.customerAmountDue).toBeDefined();
    });
  });

  it("finds an Order by its External Reference through the same filter the Company uses", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      await seedOrder(transaction, fixture, "REF-FINDME");
      const service = buildService(transaction, fixture);

      // The dedicated `referenceNumber` filter, not `search` — `search` also
      // matches Order number/Customer/mobile through a separate normalized
      // index this fixture does not populate, and this test's claim is about
      // reuse of the reference filter specifically, not the full-text index.
      const page = await service.traderPortalOrdersPage({ referenceNumber: "REF-FINDME" });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.referenceNumber).toBe("REF-FINDME");
    });
  });

  it("never returns a different Trader's Orders, even in the same Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderA = await seedTrader(transaction);
      await seedOrder(transaction, traderA, "REF-A");
      const traderB = await seedTrader(transaction, {
        company: { actorId: traderA.actorId, companyId: traderA.companyId },
      });
      await seedOrder(transaction, traderB, "REF-B");

      const serviceA = buildService(transaction, traderA);
      const pageA = await serviceA.traderPortalOrdersPage({});

      expect(pageA.items).toHaveLength(1);
      expect(pageA.items[0]?.referenceNumber).toBe("REF-A");
    });
  });

  it("ignores a client-supplied traderId filter entirely", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderA = await seedTrader(transaction);
      await seedOrder(transaction, traderA, "REF-ONLY-MINE");
      const traderB = await seedTrader(transaction, {
        company: { actorId: traderA.actorId, companyId: traderA.companyId },
      });
      await seedOrder(transaction, traderB, "REF-NOT-MINE");
      const service = buildService(transaction, traderA);

      // Casts around the Omit<...,"traderId"> type — this simulates a
      // manipulated request body reaching the service directly.
      const page = await service.traderPortalOrdersPage({
        traderId: traderB.traderId,
      } as never);

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.referenceNumber).toBe("REF-ONLY-MINE");
    });
  });
});

/**
 * The cross-Company aggregation added for Trader Portal Prompt 3T-C, Part C
 * ("one common Trader Order history"). See `trader-commerce-order-scope.ts`
 * for why the fan-out reads `trader_commerce_company_links` rather than
 * widening the session.
 */
describe.skipIf(!runDatabaseTests)("Trader portal global Orders (all Delivery Companies)", () => {
  async function seedCommerceLink(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly companyId: string;
      readonly status?: "active" | "inactive";
      readonly traderCommerceId: string;
      readonly traderId: string;
    },
  ) {
    await sql`insert into trader_commerce_company_links(
        id, trader_commerce_id, company_id, trader_id, link_source, status
      ) values (
        ${randomUUID()}::uuid, ${input.traderCommerceId}::uuid, ${input.companyId}::uuid,
        ${input.traderId}::uuid, 'manual_link', ${input.status ?? "active"}
      )`.execute(transaction);
  }

  async function seedTraderCommerceProfile(transaction: Transaction<DatabaseSchema>) {
    const id = randomUUID();
    await sql`insert into trader_commerce_profiles(id, public_name, registration_source)
      values(${id}::uuid, 'Global Orders Test Shop', 'platform_registered')`.execute(transaction);
    return id;
  }

  it("has no Trader Commerce identity yet still sees its own Orders", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      await seedOrder(transaction, fixture, "REF-NO-COMMERCE");
      const service = buildService(transaction, fixture);

      const page = await service.traderPortalOrdersPageAllCompanies({});

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.referenceNumber).toBe("REF-NO-COMMERCE");
    });
  });

  it("aggregates Orders across every actively-linked Delivery Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderCommerceId = await seedTraderCommerceProfile(transaction);
      const traderA = await seedTrader(transaction);
      await seedOrder(transaction, traderA, "REF-COMPANY-A");
      await seedCommerceLink(transaction, {
        companyId: traderA.companyId,
        traderCommerceId,
        traderId: traderA.traderId,
      });

      const traderB = await seedTrader(transaction);
      await seedOrder(transaction, traderB, "REF-COMPANY-B");
      await seedCommerceLink(transaction, {
        companyId: traderB.companyId,
        traderCommerceId,
        traderId: traderB.traderId,
      });

      const service = buildService(transaction, traderA);
      const page = await service.traderPortalOrdersPageAllCompanies({ quickView: "all" });

      const references = page.items.map((item) => item.referenceNumber).sort();
      expect(references).toEqual(["REF-COMPANY-A", "REF-COMPANY-B"]);
      const rowB = page.items.find((item) => item.referenceNumber === "REF-COMPANY-B");
      expect(rowB?.deliveryCompanyId).toBe(traderB.companyId);
    });
  });

  /* -----------------------------------------------------------------------
     T8 -- the Dashboard's Order counts previously used the current session
     Company only, while this exact page (`traderPortalOrdersPageAllCompanies`)
     already aggregated across every actively-linked Delivery Company for the
     same Trader Commerce identity. Two different totals for "how many Orders
     do I have" was a real inconsistency, fixed in `traderPortalDashboard`
     (§45) to read the identical `traderCommerceOrderScopePairs` union this
     page already used. This test proves the two now agree.
     ----------------------------------------------------------------------- */
  it("counts Orders from every actively-linked Delivery Company on the Dashboard, not just the session Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderCommerceId = await seedTraderCommerceProfile(transaction);
      const traderA = await seedTrader(transaction);
      await seedOrder(transaction, traderA, "REF-DASH-A");
      await seedCommerceLink(transaction, {
        companyId: traderA.companyId,
        traderCommerceId,
        traderId: traderA.traderId,
      });

      const traderB = await seedTrader(transaction);
      await seedOrder(transaction, traderB, "REF-DASH-B");
      await seedCommerceLink(transaction, {
        companyId: traderB.companyId,
        traderCommerceId,
        traderId: traderB.traderId,
      });

      const service = buildService(transaction, traderA);
      const [dashboard, page] = await Promise.all([
        service.traderPortalDashboard(),
        service.traderPortalOrdersPageAllCompanies({ quickView: "all" }),
      ]);

      // The two views of "how many Orders does this Trader Commerce identity
      // have" must report the SAME count -- that is the whole claim.
      expect(dashboard.orders.total).toBe(page.items.length);
      expect(dashboard.orders.total).toBe(2);
      const recentReferences = dashboard.recentOrders.map((row) => row.orderNumber).sort();
      const pageOrderNumbers = page.items.map((row) => row.orderNumber).sort();
      expect(recentReferences).toEqual(pageOrderNumbers);
    });
  });

  it("does not aggregate a link whose status is inactive", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderCommerceId = await seedTraderCommerceProfile(transaction);
      const traderA = await seedTrader(transaction);
      await seedOrder(transaction, traderA, "REF-ACTIVE-LINK");
      await seedCommerceLink(transaction, {
        companyId: traderA.companyId,
        traderCommerceId,
        traderId: traderA.traderId,
      });

      const traderB = await seedTrader(transaction);
      await seedOrder(transaction, traderB, "REF-INACTIVE-LINK");
      await seedCommerceLink(transaction, {
        companyId: traderB.companyId,
        status: "inactive",
        traderCommerceId,
        traderId: traderB.traderId,
      });

      const service = buildService(transaction, traderA);
      const page = await service.traderPortalOrdersPageAllCompanies({ quickView: "all" });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.referenceNumber).toBe("REF-ACTIVE-LINK");
    });
  });

  it("filters to a single selected Delivery Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderCommerceId = await seedTraderCommerceProfile(transaction);
      const traderA = await seedTrader(transaction);
      await seedOrder(transaction, traderA, "REF-FILTER-A");
      await seedCommerceLink(transaction, {
        companyId: traderA.companyId,
        traderCommerceId,
        traderId: traderA.traderId,
      });

      const traderB = await seedTrader(transaction);
      await seedOrder(transaction, traderB, "REF-FILTER-B");
      await seedCommerceLink(transaction, {
        companyId: traderB.companyId,
        traderCommerceId,
        traderId: traderB.traderId,
      });

      const service = buildService(transaction, traderA);
      const page = await service.traderPortalOrdersPageAllCompanies({
        deliveryCompanyId: traderB.companyId,
        quickView: "all",
      });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.referenceNumber).toBe("REF-FILTER-B");
    });
  });
});

describe.skipIf(!runDatabaseTests)("Trader portal Orders CSV import", () => {
  // `serviceFee` is supplied explicitly with a reason, sidestepping the
  // separate concern of configuring Trader/Area pricing for this fixture —
  // that path is already covered by the Company import's own tests. What
  // this suite is verifying is Trader scoping, not pricing resolution.
  const csvFor = (reference: string) =>
    "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount," +
    "serviceFee,packageCount\n" +
    `SN-${reference},${reference},Dev Customer,971509990000,"Deira, Dubai",100,10,1\n`;

  async function activateGeneratedSerials(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
    prefix: string,
  ): Promise<void> {
    await sql`update companies set shipment_prefix=${prefix} where id=${companyId}::uuid`.execute(
      transaction,
    );
    await sql`update companies set shipment_serial_enabled_at=now() where id=${companyId}::uuid`.execute(
      transaction,
    );
  }

  it("rejects caller-supplied serials after activation", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      await activateGeneratedSerials(transaction, fixture.companyId, "CSV");
      const service = buildService(transaction, fixture);
      const result = await service.createTraderPortalOrdersImport(
        { csv: csvFor("REF-ACTIVE-REJECT") } as never,
        randomUUID(),
      );
      expect(result.importedRows).toBe(0);
      expect(result.errors[0]).toMatch(/generates it automatically|must not be supplied/i);
    });
  });

  it("generates serial and normalized values together for activated imports", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      await activateGeneratedSerials(transaction, fixture.companyId, "CSV");
      const service = buildService(transaction, fixture);
      const csv =
        "referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount,serviceFee,packageCount\n" +
        'REF-ACTIVE-GENERATE,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n';
      const result = await service.createTraderPortalOrdersImport({ csv } as never, randomUUID());
      expect(result.importedRows).toBe(1);
      const created = await sql<{ normalized: string; serial: string }>`
        select serial_number serial, serial_number_normalized normalized from orders
        where company_id=${fixture.companyId}::uuid and reference_number='REF-ACTIVE-GENERATE'
      `.execute(transaction);
      expect(created.rows[0]?.serial).toBe("CSV0000001");
      expect(created.rows[0]?.normalized).toBe("csv0000001");
    });
  });

  it("creates Orders owned by the authenticated Trader with no traderId column supplied", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      const service = buildService(transaction, fixture);

      const result = await service.createTraderPortalOrdersImport(
        { csv: csvFor("REF-BULK-1") } as never,
        randomUUID(),
      );

      expect(result.importedRows).toBe(1);
      const created = await sql<{ traderId: string }>`
        select trader_id as "traderId" from orders
         where company_id = ${fixture.companyId}::uuid and reference_number = 'REF-BULK-1'
      `.execute(transaction);
      expect(created.rows[0]?.traderId).toBe(fixture.traderId);
    });
  });

  it("ignores a traderId column the Trader's own file supplies, forcing its own id instead", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderA = await seedTrader(transaction);
      const traderB = await seedTrader(transaction, {
        company: { actorId: traderA.actorId, companyId: traderA.companyId },
      });
      const service = buildService(transaction, traderA);

      const maliciousCsv =
        "serialNumber,referenceNumber,traderId,driverId,customerName,customerMobileNumber," +
        "customerAddress,codAmount,serviceFee,packageCount\n" +
        `SN-HIJACK,REF-HIJACK,${traderB.traderId},${randomUUID()},Dev Customer,971509990000,` +
        `"Deira, Dubai",100,10,1\n`;

      const result = await service.createTraderPortalOrdersImport(
        { csv: maliciousCsv } as never,
        randomUUID(),
      );

      expect(result.importedRows).toBe(1);
      const created = await sql<{ assignedDriverId: string | null; traderId: string }>`
        select trader_id as "traderId", assigned_driver_id as "assignedDriverId" from orders
         where company_id = ${traderA.companyId}::uuid and reference_number = 'REF-HIJACK'
      `.execute(transaction);
      // The Order belongs to the CALLING Trader, never the one the file named.
      expect(created.rows[0]?.traderId).toBe(traderA.traderId);
      expect(created.rows[0]?.assignedDriverId).toBeNull();
    });
  });

  it("writes nothing when a row is invalid — no partial silent success", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      const service = buildService(transaction, fixture);

      const invalidCsv =
        "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount,packageCount\n" +
        'SN-BAD,REF-BAD,,971509990000,"Deira, Dubai",100,1\n'; // blank customerName

      const result = await service.createTraderPortalOrdersImport(
        { csv: invalidCsv } as never,
        randomUUID(),
      );

      expect(result.importedRows).toBe(0);
      const created = await sql<{ count: string }>`
        select count(*)::text as count from orders
         where company_id = ${fixture.companyId}::uuid and reference_number = 'REF-BAD'
      `.execute(transaction);
      expect(created.rows[0]?.count).toBe("0");
    });
  });

  /* -------------------------------------------------------------------------
     T9 §32/33 -- a duplicate Reference Number, whether it duplicates another
     row in the SAME file or an Order that already exists, hits
     `orders_reference_number_normalized_unique` (a real per-Company unique
     index). Because the whole import runs inside one transaction and a
     mid-loop failure is re-thrown rather than swallowed (see `importOrdersCsv`
     above), the constraint violation rolls back every row already inserted
     this batch -- so a duplicate anywhere in the file is an all-or-nothing
     rejection, never a silent partial import or a silently-created duplicate.
     ------------------------------------------------------------------------- */
  it("rejects the whole batch atomically when two rows share a Reference Number", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      const service = buildServiceWithRealTransactions(transaction, fixture);

      const duplicateCsv =
        "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount," +
        "serviceFee,packageCount\n" +
        'SN-DUP-1,REF-DUP-SAME,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n' +
        'SN-DUP-2,REF-DUP-SAME,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n';

      await expect(
        service.createTraderPortalOrdersImport({ csv: duplicateCsv } as never, randomUUID()),
      ).rejects.toThrow();

      const created = await sql<{ count: string }>`
        select count(*)::text as count from orders
         where company_id = ${fixture.companyId}::uuid and reference_number = 'REF-DUP-SAME'
      `.execute(transaction);
      expect(created.rows[0]?.count).toBe("0");
    });
  });

  it("rejects a batch atomically when its Reference Number duplicates an Order that already exists", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      await seedOrder(transaction, fixture, "REF-DUP-EXISTING");
      const service = buildService(transaction, fixture);

      const csv =
        "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount," +
        "serviceFee,packageCount\n" +
        'SN-DUP-NEW,REF-DUP-EXISTING,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n';

      await expect(
        service.createTraderPortalOrdersImport({ csv } as never, randomUUID()),
      ).rejects.toThrow();

      const created = await sql<{ count: string }>`
        select count(*)::text as count from orders
         where company_id = ${fixture.companyId}::uuid and reference_number = 'REF-DUP-EXISTING'
      `.execute(transaction);
      // Only the pre-seeded Order survives -- the import created nothing.
      expect(created.rows[0]?.count).toBe("1");
    });
  });
});

/**
 * The write-side counterpart of the cross-Company aggregation above (Trader
 * Portal Prompt 3T-C, Part D): a Trader creating one Order, or one bulk
 * import batch, under a Delivery Company other than its own login session's
 * Company. See `resolveTraderPortalDeliveryCompany` for the mechanism
 * (`tenants.run()`, no session/auth rewrite).
 */
describe.skipIf(!runDatabaseTests)(
  "Trader portal Order creation — Delivery Company selection",
  () => {
    async function seedCommerceLink(
      transaction: Transaction<DatabaseSchema>,
      input: {
        readonly companyId: string;
        readonly status?: "active" | "inactive";
        readonly traderCommerceId: string;
        readonly traderId: string;
      },
    ) {
      await sql`insert into trader_commerce_company_links(
        id, trader_commerce_id, company_id, trader_id, link_source, status
      ) values (
        ${randomUUID()}::uuid, ${input.traderCommerceId}::uuid, ${input.companyId}::uuid,
        ${input.traderId}::uuid, 'manual_link', ${input.status ?? "active"}
      )`.execute(transaction);
    }

    async function seedTraderCommerceProfile(transaction: Transaction<DatabaseSchema>) {
      const id = randomUUID();
      await sql`insert into trader_commerce_profiles(id, public_name, registration_source)
      values(${id}::uuid, 'Global Orders Test Shop', 'platform_registered')`.execute(transaction);
      return id;
    }

    async function seedTraderPrice(
      transaction: Transaction<DatabaseSchema>,
      fixture: {
        readonly actorId: string;
        readonly areaId: string;
        readonly companyId: string;
        readonly traderId: string;
      },
      fee: number,
    ) {
      const area = (
        await sql<{ emirateId: string }>`
        select emirate_id as "emirateId" from areas where id = ${fixture.areaId}::uuid
      `.execute(transaction)
      ).rows[0]!;
      await sql`insert into trader_service_prices(
        company_id, trader_id, emirate_id, area_id, service_fee, created_by_account_id
      ) values (
        ${fixture.companyId}::uuid, ${fixture.traderId}::uuid, ${area.emirateId}::uuid,
        ${fixture.areaId}::uuid, ${fee}, ${fixture.actorId}::uuid
      )`.execute(transaction);
    }

    const orderInput = (areaId: string, reference: string) => ({
      areaId,
      codAmount: 100,
      customerAddress: "Deira, Dubai",
      customerMobileNumber: "971509990000",
      customerName: "Dev Customer",
      inlineCustomer: { areaId, mobileNumber: "971509990000", name: "Dev Customer" },
      packageCount: 1,
      referenceNumber: reference,
      serialNumber: `SN-${reference}`,
    });

    it("auto-selects the single linked Company when no selection is sent", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seedTrader(transaction);
        await seedTraderPrice(transaction, fixture, 15);
        const service = buildService(transaction, fixture);

        const order = await service.createTraderPortalOrder(
          orderInput(fixture.areaId, "REF-AUTO-SELECT") as never,
          randomUUID(),
          randomUUID(),
        );

        expect(order.serviceFee).toBe("15.00");
        const stored = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders where id = ${order.id}::uuid
      `.execute(transaction);
        expect(stored.rows[0]?.companyId).toBe(fixture.companyId);
        expect(stored.rows[0]?.traderId).toBe(fixture.traderId);
      });
    });

    it("resolves to the caller's own Company Trader record and pricing when it is explicitly selected", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedTraderPrice(transaction, traderA, 15);
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const service = buildService(transaction, traderA);
        // Explicitly selecting the caller's own Company (the multi-Company
        // dropdown's default) exercises the field end-to-end without hitting
        // the cross-Company case the next test proves.
        const order = await service.createTraderPortalOrder(
          {
            ...orderInput(traderA.areaId, "REF-OWN-SELECTED"),
            deliveryCompanyId: traderA.companyId,
          } as never,
          randomUUID(),
          randomUUID(),
        );

        expect(order.serviceFee).toBe("15.00");
        const stored = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders where id = ${order.id}::uuid
      `.execute(transaction);
        expect(stored.rows[0]?.companyId).toBe(traderA.companyId);
        expect(stored.rows[0]?.traderId).toBe(traderA.traderId);
      });
    });

    /* -------------------------------------------------------------------------
     T8 §29 -- "If two Trader records exist inside the same Company, ensure
     the Order uses the Trader mapped to the authenticated Trader Commerce
     identity. Do not choose by name. Do not choose first record." The closest
     existing test above ("resolves to the caller's own Company Trader record
     and pricing...") only covers two DIFFERENT Companies -- traderA and
     traderB each get their own new Company via a bare seedTrader() call. This
     test instead plants a decoy second Trader record inside the SAME Company
     as the linked one, and proves the Order is written against the linked
     Trader's id, never the decoy's, even though the decoy exists first in
     insertion order and would sort first by name.
     ------------------------------------------------------------------------- */
    it("uses the commerce-linked Trader, not a decoy Trader record in the same Company", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const linkedTrader = await seedTrader(transaction);
        await seedTraderPrice(transaction, linkedTrader, 15);
        await seedCommerceLink(transaction, {
          companyId: linkedTrader.companyId,
          traderCommerceId,
          traderId: linkedTrader.traderId,
        });

        // Decoy: a second, unrelated Trader record inside the exact same
        // Company, never linked to the Trader Commerce identity.
        const decoyTrader = await seedTrader(transaction, {
          company: { actorId: linkedTrader.actorId, companyId: linkedTrader.companyId },
        });

        const service = buildService(transaction, linkedTrader);
        const order = await service.createTraderPortalOrder(
          {
            ...orderInput(linkedTrader.areaId, "REF-NOT-DECOY"),
            deliveryCompanyId: linkedTrader.companyId,
          } as never,
          randomUUID(),
          randomUUID(),
        );

        expect(order.serviceFee).toBe("15.00");
        const stored = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders where id = ${order.id}::uuid
      `.execute(transaction);
        expect(stored.rows[0]?.companyId).toBe(linkedTrader.companyId);
        expect(stored.rows[0]?.traderId).toBe(linkedTrader.traderId);
        expect(stored.rows[0]?.traderId).not.toBe(decoyTrader.traderId);
      });
    });

    /**
     * The mandatory pricing-proof test gate (Trader Portal Prompt 3T-C FINAL,
     * §12): same Trader Commerce identity, same Area, two different Companies
     * each with their OWN Trader/Area price. One Order through each Company
     * selection must land under that Company with THAT Company's fee, proving
     * `resolveTraderPortalDeliveryCompany` + `tenants.run()` +
     * `actingAccountIdOverride` genuinely redirect the write, not just resolve
     * a target and silently keep pricing/ownership from the caller's own
     * Company.
     */
    it("creates a real Order under a different linked Company, with that Company's own Trader resolution and pricing", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedTraderPrice(transaction, traderA, 15); // Fee A
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedTraderPrice(transaction, traderB, 40); // Fee B — deliberately different
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const service = buildService(transaction, traderA);

        const orderA = await service.createTraderPortalOrder(
          orderInput(traderA.areaId, "REF-PRICE-PROOF-A") as never,
          randomUUID(),
          randomUUID(),
        );
        const orderB = await service.createTraderPortalOrder(
          {
            ...orderInput(traderB.areaId, "REF-PRICE-PROOF-B"),
            deliveryCompanyId: traderB.companyId,
          } as never,
          randomUUID(),
          randomUUID(),
        );

        expect(orderA.serviceFee).toBe("15.00");
        expect(orderB.serviceFee).toBe("40.00");

        const storedA = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders where id = ${orderA.id}::uuid
      `.execute(transaction);
        const storedB = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders where id = ${orderB.id}::uuid
      `.execute(transaction);
        expect(storedA.rows[0]?.companyId).toBe(traderA.companyId);
        expect(storedA.rows[0]?.traderId).toBe(traderA.traderId);
        expect(storedB.rows[0]?.companyId).toBe(traderB.companyId);
        expect(storedB.rows[0]?.traderId).toBe(traderB.traderId);
      });
    });

    it("rejects a Delivery Company the Trader has no active relationship with", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seedTrader(transaction);
        const unrelatedCompanyId = randomUUID();
        const service = buildService(transaction, fixture);

        await expect(
          service.createTraderPortalOrder(
            {
              ...orderInput(fixture.areaId, "REF-REJECTED"),
              deliveryCompanyId: unrelatedCompanyId,
            } as never,
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "delivery_company_not_linked" });

        const created = await sql<{ count: string }>`
        select count(*)::text as count from orders where reference_number = 'REF-REJECTED'
      `.execute(transaction);
        expect(created.rows[0]?.count).toBe("0");
      });
    });

    it("rejects a Delivery Company whose link is inactive", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          status: "inactive",
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const service = buildService(transaction, traderA);

        await expect(
          service.createTraderPortalOrder(
            {
              ...orderInput(traderB.areaId, "REF-INACTIVE-LINK-BLOCKED"),
              deliveryCompanyId: traderB.companyId,
            } as never,
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "delivery_company_not_linked" });
      });
    });

    /**
     * Cross-Trader denial (§48): a Company that belongs to a DIFFERENT
     * Trader Commerce identity entirely (not merely inactive) must be
     * rejected exactly the same way as any other unrelated Company — Trader A
     * gets no access to Trader B's Company Trader, pricing, or Order scope
     * just because Trader B happens to exist.
     */
    it("rejects a Company belonging to a completely different Trader Commerce identity", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const ownCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId: ownCommerceId,
          traderId: traderA.traderId,
        });

        const otherCommerceId = await seedTraderCommerceProfile(transaction);
        const traderB = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId: otherCommerceId,
          traderId: traderB.traderId,
        });

        const service = buildService(transaction, traderA);

        await expect(
          service.createTraderPortalOrder(
            {
              ...orderInput(traderB.areaId, "REF-CROSS-TRADER-DENIED"),
              deliveryCompanyId: traderB.companyId,
            } as never,
            randomUUID(),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "delivery_company_not_linked" });

        const created = await sql<{ count: string }>`
        select count(*)::text as count from orders where reference_number = 'REF-CROSS-TRADER-DENIED'
      `.execute(transaction);
        expect(created.rows[0]?.count).toBe("0");
      });
    });

    it("bulk import resolves every row to the caller's own Company Trader record when explicitly selected", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const csv =
          "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount," +
          "serviceFee,packageCount\n" +
          'SN-BULK-1,REF-BULK-1,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n' +
          'SN-BULK-2,REF-BULK-2,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n';

        const service = buildService(transaction, traderA);
        // Explicitly selecting the caller's own Company (the one it is logged
        // into) exercises the DTO field end-to-end without hitting the
        // cross-Company boundary the next test documents.
        const result = await service.createTraderPortalOrdersImport(
          { csv, deliveryCompanyId: traderA.companyId } as never,
          randomUUID(),
        );

        expect(result.importedRows).toBe(2);
        const created = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders
         where reference_number in ('REF-BULK-1', 'REF-BULK-2')
      `.execute(transaction);
        expect(created.rows).toHaveLength(2);
        for (const row of created.rows) {
          expect(row.companyId).toBe(traderA.companyId);
          expect(row.traderId).toBe(traderA.traderId);
        }
      });
    });

    it("bulk import resolves every row to a DIFFERENT linked Company's own Trader record when that Company is selected", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const csv =
          "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount," +
          "serviceFee,packageCount\n" +
          'SN-BULK-1,REF-BULK-1,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n' +
          'SN-BULK-2,REF-BULK-2,Dev Customer,971509990000,"Deira, Dubai",100,10,1\n';

        const service = buildService(transaction, traderA);
        const result = await service.createTraderPortalOrdersImport(
          { csv, deliveryCompanyId: traderB.companyId } as never,
          randomUUID(),
        );

        expect(result.importedRows).toBe(2);
        const created = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders
         where reference_number in ('REF-BULK-1', 'REF-BULK-2')
      `.execute(transaction);
        expect(created.rows).toHaveLength(2);
        for (const row of created.rows) {
          expect(row.companyId).toBe(traderB.companyId);
          expect(row.traderId).toBe(traderB.traderId);
        }
      });
    });

    /**
     * The bulk pricing-proof test gate (§18): two batches, same Trader
     * Commerce identity, same Area, different Companies with different
     * configured prices, CSV rows that omit `serviceFee` so the price comes
     * from `resolveServiceFee`'s Trader/Area lookup rather than the file.
     */
    it("prices two bulk batches from each selected Company's own Trader/Area table", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedTraderPrice(transaction, traderA, 12); // Fee A
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedTraderPrice(transaction, traderB, 55); // Fee B
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const csvFor = (reference: string) =>
          "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress,codAmount,packageCount\n" +
          `SN-${reference},${reference},Dev Customer,971509990000,"Deira, Dubai",100,1\n`;

        const service = buildService(transaction, traderA);
        const resultA = await service.createTraderPortalOrdersImport(
          { csv: csvFor("REF-BULK-PRICE-A"), deliveryCompanyId: traderA.companyId } as never,
          randomUUID(),
        );
        const resultB = await service.createTraderPortalOrdersImport(
          { csv: csvFor("REF-BULK-PRICE-B"), deliveryCompanyId: traderB.companyId } as never,
          randomUUID(),
        );

        expect(resultA.importedRows).toBe(1);
        expect(resultB.importedRows).toBe(1);
        const priced = await sql<{ referenceNumber: string; serviceFee: string }>`
        select reference_number as "referenceNumber", service_fee::text as "serviceFee" from orders
         where reference_number in ('REF-BULK-PRICE-A', 'REF-BULK-PRICE-B')
         order by reference_number
      `.execute(transaction);
        expect(priced.rows).toEqual([
          { referenceNumber: "REF-BULK-PRICE-A", serviceFee: "12.00" },
          { referenceNumber: "REF-BULK-PRICE-B", serviceFee: "55.00" },
        ]);
      });
    });

    /**
     * Historical freeze (§52 / Part A §8): once created, an Order's
     * `company_id`/`trader_id` must never move even after the underlying
     * relationship/default changes.
     */
    it("keeps an Order's Company/Trader unchanged after its relationship is later deactivated", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const traderCommerceId = await seedTraderCommerceProfile(transaction);
        const traderA = await seedTrader(transaction);
        await seedCommerceLink(transaction, {
          companyId: traderA.companyId,
          traderCommerceId,
          traderId: traderA.traderId,
        });
        const traderB = await seedTrader(transaction);
        await seedTraderPrice(transaction, traderB, 20);
        await seedCommerceLink(transaction, {
          companyId: traderB.companyId,
          traderCommerceId,
          traderId: traderB.traderId,
        });

        const service = buildService(transaction, traderA);
        const order = await service.createTraderPortalOrder(
          {
            ...orderInput(traderB.areaId, "REF-HISTORICAL-FREEZE"),
            deliveryCompanyId: traderB.companyId,
          } as never,
          randomUUID(),
          randomUUID(),
        );

        // The relationship that made Company B reachable is deactivated AFTER
        // the Order already exists.
        await sql`
        update trader_commerce_company_links set status = 'inactive'
         where trader_commerce_id = ${traderCommerceId}::uuid and company_id = ${traderB.companyId}::uuid
      `.execute(transaction);

        const stored = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from orders where id = ${order.id}::uuid
      `.execute(transaction);
        expect(stored.rows[0]?.companyId).toBe(traderB.companyId);
        expect(stored.rows[0]?.traderId).toBe(traderB.traderId);

        // And the now-inactive Company can no longer be selected for a NEW Order.
        await expect(
          service.createTraderPortalOrder(
            {
              ...orderInput(traderB.areaId, "REF-AFTER-DEACTIVATION"),
              deliveryCompanyId: traderB.companyId,
            } as never,
            randomUUID(),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: "delivery_company_not_linked" });
      });
    });
  },
);
