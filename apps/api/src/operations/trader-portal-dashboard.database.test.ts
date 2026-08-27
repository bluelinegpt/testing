import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext } from "../security/identity-context.js";
import type { TenantContext } from "../tenancy/tenant-context.js";

import { OperationsService } from "./operations.service.js";

/**
 * The Trader Dashboard and Trader profile self-service (Trader Workspace
 * Prompt 3T-A, §48/§53).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS
 * ---------------------------------------------------------------------------
 *
 * The Dashboard aggregates across four tables (`orders`, `trader_storefronts`,
 * `trader_storefront_products`, `trader_delivery_company_relationships`) that
 * were built in separate, unrelated prompts. The failure mode this test file
 * exists to catch is a join that quietly widens scope — counting a SECOND
 * Trader's Orders, or a Store that belongs to someone else — which a
 * type-level review of the query text would not surface.
 *
 * `RUN_INTEGRITY_DATABASE` matches the flag the sibling
 * `trader-payable-ledger.database.test.ts` already uses for a raw
 * `OperationsService`-adjacent schema suite in this directory.
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const rollback = Symbol("rollback trader portal dashboard test");
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

/**
 * A Company, an Account/Trader pair, a delivered Order, and (when supplied)
 * a Trader Commerce Store with Products.
 */
async function seedTrader(
  transaction: Transaction<DatabaseSchema>,
  input: {
    /**
     * Reuse an existing Company (and its actor). Passed by the isolation test
     * so two Traders sit in the SAME Company — the scenario that actually
     * exercises the `trader_id` filter, since two different Companies would
     * already be isolated by `company_id` alone regardless of what the query
     * does with `trader_id`.
     */
    readonly company?: { readonly actorId: string; readonly companyId: string };
    readonly withStore?: boolean;
  } = {},
) {
  const companyId = input.company?.companyId ?? randomUUID();
  const actorId = input.company?.actorId ?? randomUUID();
  const accountId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();

  if (input.company === undefined) {
    await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
      values(${companyId}::uuid, ${`TP-${companyId.slice(0, 8)}`}, ${`tp-${companyId.slice(0, 8)}`},
             'Trader Portal Test', 'active', now())`.execute(transaction);
    await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
      values (${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`tp.a.${actorId}`}, 'x', 'en')`.execute(
      transaction,
    );
  }
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
    values (${accountId}::uuid, ${companyId}::uuid, 'trader', ${`tp.t.${accountId}`}, 'x', 'en')`.execute(
    transaction,
  );
  await sql`insert into traders(id, company_id, account_id, code, name_en, mobile_number, created_by_account_id)
    values(${traderId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`TRD-${traderId.slice(0, 6)}`},
           'Portal Trader', '971501234567', ${actorId}::uuid)`.execute(transaction);
  // `traderForAccount` (the method every Trader portal endpoint resolves
  // through) requires an ACTIVE link, not just the `traders` row itself.
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
  await sql`insert into orders(
      service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
      created_by_account_id, customer_name, customer_mobile_number, customer_address,
      package_count, payment_condition, final_service_fee_snapshot, customer_provenance_status,
      pricing_provenance_status, trader_gross_payable, trader_net_payable, cod_amount,
      customer_amount_due, delivery_status, driver_reconciliation_status, trader_settlement_status,
      return_status
    ) values (
      'Zero configured Service Fee (fixture)', ${randomUUID()}::uuid, ${companyId}::uuid,
      ${`ORD-${randomUUID().slice(0, 8)}`}, current_date, ${traderId}::uuid, ${areaId}::uuid,
      ${actorId}::uuid, 'Dev Customer', '971509990000', 'Deira, Dubai', 1, 'customer_pays_cod_and_fee',
      0, 'legacy_unattributed', 'legacy_unattributed', 100.00, 100.00, 100.00, 100.00,
      'delivered', 'not_applicable', 'unsettled', 'not_applicable'
    )`.execute(transaction);

  let storefrontId: string | null = null;
  if (input.withStore) {
    const commerceId = randomUUID();
    storefrontId = randomUUID();
    await sql`insert into trader_commerce_profiles(id, public_name, registration_source, approval_status, is_active, created_by_account_id, updated_by_account_id)
      values(${commerceId}::uuid, 'Portal Trader Store', 'delivery_company_registered', 'approved', true, ${actorId}::uuid, ${actorId}::uuid)`.execute(
      transaction,
    );
    await sql`insert into trader_commerce_company_links(trader_commerce_id, company_id, trader_id, link_source, status, created_by_account_id)
      values(${commerceId}::uuid, ${companyId}::uuid, ${traderId}::uuid, 'delivery_company_registered', 'active', ${actorId}::uuid)`.execute(
      transaction,
    );
    await sql`insert into trader_storefronts(id, company_id, trader_id, trader_commerce_id, display_name, slug, business_template, theme, status, published_at, created_by_account_id, updated_by_account_id)
      values(${storefrontId}::uuid, ${companyId}::uuid, ${traderId}::uuid, ${commerceId}::uuid,
             'Portal Trader Store', ${`portal-store-${storefrontId.slice(0, 8)}`}, 'general', 'clean_light',
             'published', now(), ${actorId}::uuid, ${actorId}::uuid)`.execute(transaction);
    const categoryId = randomUUID();
    await sql`insert into trader_storefront_categories(id, company_id, storefront_id, name_en, slug, created_by_account_id, updated_by_account_id)
      values(${categoryId}::uuid, ${companyId}::uuid, ${storefrontId}::uuid, 'Dev Category',
             ${`dev-category-${categoryId.slice(0, 8)}`}, ${actorId}::uuid, ${actorId}::uuid)`.execute(
      transaction,
    );
    await sql`insert into trader_storefront_products(id, storefront_id, category_id, name, slug, product_code, selling_price, lifecycle_status, availability_status, created_by_account_id, updated_by_account_id)
      values (${randomUUID()}::uuid, ${storefrontId}::uuid, ${categoryId}::uuid, 'Active Product', ${`active-${randomUUID().slice(0, 8)}`}, ${`SKU-${randomUUID().slice(0, 8)}`}, 50.00, 'active', 'available', ${actorId}::uuid, ${actorId}::uuid),
             (${randomUUID()}::uuid, ${storefrontId}::uuid, ${categoryId}::uuid, 'Draft Product', ${`draft-${randomUUID().slice(0, 8)}`}, ${`SKU-${randomUUID().slice(0, 8)}`}, 30.00, 'draft', 'available', ${actorId}::uuid, ${actorId}::uuid)`.execute(
      transaction,
    );
  }

  return { accountId, actorId, companyId, storefrontId, traderId };
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly accountId: string; readonly companyId: string; readonly traderId: string },
): OperationsService {
  const tenants = {
    current: (): TenantContext => ({ companyId: input.companyId, identityId: input.accountId }),
    run: async <T>(_context: TenantContext, work: () => Promise<T>) => work(),
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
  // A real `KyselyTransactionManager` calls `.transaction()` on whatever it
  // holds, and Kysely explicitly refuses to open a nested transaction on a
  // `Transaction` object. Since the whole test already runs inside one
  // rolled-back transaction, the manager here just runs the work directly
  // against it — atomicity for the test comes from the outer rollback, not
  // from a savepoint this driver cannot create.
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
  );
}

describe.skipIf(!runDatabaseTests)("Trader portal Dashboard", () => {
  it("reports zero Commerce and an honest empty Store summary before a Store exists", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      const service = buildService(transaction, fixture);

      const dashboard = await service.traderPortalDashboard();

      expect(dashboard.commerce.hasStore).toBe(false);
      expect(dashboard.commerce.totalProducts).toBe(0);
      expect(dashboard.commerce.storeName).toBeNull();
      // The Order this Trader owns is still reported — a missing Store must
      // not hide real Delivery Order history.
      expect(dashboard.orders.total).toBe(1);
      expect(dashboard.orders.delivered).toBe(1);
    });
  });

  it("reports real Product and Delivery Company counts once a Store exists", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction, { withStore: true });
      const service = buildService(transaction, fixture);

      const dashboard = await service.traderPortalDashboard();

      expect(dashboard.commerce.hasStore).toBe(true);
      expect(dashboard.commerce.storeName).toBe("Portal Trader Store");
      expect(dashboard.commerce.totalProducts).toBe(2);
      expect(dashboard.commerce.activeProducts).toBe(1);
      expect(dashboard.commerce.draftProducts).toBe(1);
      // Zero-Delivery-Company is a valid, unexceptional state (§40 of the
      // Customer Prompt 3A/Store Order groundwork applies equally here).
      expect(dashboard.commerce.deliveryCompanyCount).toBe(0);
    });
  });

  it("never counts a different Trader's Orders or Products", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const traderA = await seedTrader(transaction, { withStore: true });
      // Trader B in the SAME Company: `company_id` alone would already
      // isolate two different Companies, so this is the case that actually
      // exercises the `trader_id` filter in the Dashboard query.
      await seedTrader(transaction, {
        company: { actorId: traderA.actorId, companyId: traderA.companyId },
        withStore: true,
      });
      const service = buildService(transaction, traderA);

      const dashboard = await service.traderPortalDashboard();

      // Each seed creates exactly one Order and two Products for its own
      // Trader; a leak would double these counts.
      expect(dashboard.orders.total).toBe(1);
      expect(dashboard.commerce.totalProducts).toBe(2);
    });
  });

  /* -------------------------------------------------------------------------
     T10 -- Final Trader Portal acceptance found that a 'closed' Order (the
     POST-delivery terminal state -- see `order-workflow-guidance.ts`'s own
     comment on this) was counted in `orders.total` but in NONE of the
     breakdown buckets (new/active/delivered/cancelled/returned), so the
     breakdown never summed to the total on a live Dashboard with any closed
     Orders. Fixed by folding 'closed' into the same 'delivered' bucket the
     rest of this file already treats it as (see the `('delivered', 'closed',
     ...)` groupings elsewhere in `operations.service.ts`).
     ------------------------------------------------------------------------- */
  it("counts a closed Order as delivered, so the breakdown sums to the total", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      // `seedTrader` already seeds one 'delivered' Order; add one 'closed'.
      await sql`update orders set delivery_status = 'closed', closed_at = now()
                 where trader_id = ${fixture.traderId}::uuid`.execute(transaction);
      const service = buildService(transaction, fixture);

      const dashboard = await service.traderPortalDashboard();

      expect(dashboard.orders.total).toBe(1);
      expect(dashboard.orders.delivered).toBe(1);
      const breakdown =
        dashboard.orders.newOrders +
        dashboard.orders.active +
        dashboard.orders.delivered +
        dashboard.orders.cancelled +
        dashboard.orders.returned;
      expect(breakdown).toBe(dashboard.orders.total);
    });
  });

  it("updates only the permitted profile fields, leaving identity fields untouched", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seedTrader(transaction);
      const service = buildService(transaction, fixture);

      const before = await service.traderPortalProfile();
      const updated = await service.updateTraderPortalProfile({
        commercialNumber: "CN-12345",
        contactPerson: "Dev Contact",
        email: "dev.contact@example.test",
        preferredLanguage: "ar",
        telephone: "+971 4 000 0000",
      });

      expect(updated.contactPerson).toBe("Dev Contact");
      expect(updated.commercialNumber).toBe("CN-12345");
      expect(updated.preferredLanguage).toBe("ar");
      // The primary name and login mobile are not part of this DTO at all —
      // they must survive the update unchanged.
      expect(updated.name).toBe(before.name);
      expect(updated.mobileNumber).toBe(before.mobileNumber);
    });
  });
});
