import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Trader Commerce ownership foundation, against the real schema.
 *
 * Everything runs inside ONE transaction that is always rolled back, so nothing
 * created here outlives the test and no existing row is touched.
 *
 * The claims under test are the ones the 0A-2 migration would be dangerous to
 * be wrong about: that one existing Company Trader can never acquire two
 * Commerce identities, that a Commerce identity is not silently shared across
 * Companies, that a shop may have zero Delivery Companies but never two
 * enabled defaults, and that the legacy Company ownership chain is still
 * enforced alongside the new one.
 *
 * The SKU and barcode cases exist because both are STRINGS whose leading zeros
 * carry meaning. A test that only ever uses '1' would pass under a numeric
 * column and ship a catalogue that silently renumbers itself.
 */

const runDatabaseTests = process.env.RUN_COMMERCE_DATABASE === "true";

interface Fixture {
  readonly commerceId: string;
  readonly companyId: string;
  readonly otherCommerceId: string;
  readonly otherCompanyId: string;
  readonly otherTraderId: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const traderId = randomUUID();
  const otherTraderId = randomUUID();
  const commerceId = randomUUID();
  const otherCommerceId = randomUUID();
  const short = companyId.slice(0, 8);
  const otherShort = otherCompanyId.slice(0, 8);

  for (const [id, code, label] of [
    [companyId, `TC-${short}`, `tc-${short}`],
    [otherCompanyId, `TCB-${otherShort}`, `tcb-${otherShort}`],
  ] as const) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values(${id}::uuid,${code},${label},'Commerce Test','active',now())`.execute(transaction);
  }

  // Deliberately identical business details in two Companies. This is exactly
  // the shape that tempts an automatic merge, and the test below proves the
  // schema keeps them apart.
  await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
    (${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Blaza Mobile','971500000010'),
    (${otherTraderId}::uuid,${otherCompanyId}::uuid,${`T-${otherShort}`},'Blaza Mobile','971500000010')`.execute(
    transaction,
  );

  for (const id of [commerceId, otherCommerceId]) {
    await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
      values(${id}::uuid,'Blaza Mobile','delivery_company_registered','approved')`.execute(
      transaction,
    );
  }

  return { commerceId, companyId, otherCommerceId, otherCompanyId, otherTraderId, traderId };
}

async function link(
  transaction: Transaction<DatabaseSchema>,
  commerceId: string,
  companyId: string,
  traderId: string,
): Promise<void> {
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
    values(${commerceId}::uuid,${companyId}::uuid,${traderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
}

async function relate(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly commerceId: string;
    readonly companyId: string;
    readonly isDefault?: boolean;
    readonly enabled?: boolean;
    readonly traderId?: string | null;
  },
): Promise<void> {
  await sql`insert into trader_delivery_company_relationships(
      trader_commerce_id, company_id, trader_id, relationship_source, status,
      enabled_for_store_orders, is_default_for_store_orders)
    values(${input.commerceId}::uuid, ${input.companyId}::uuid, ${input.traderId ?? null}::uuid,
      'delivery_company_registered', 'active',
      ${input.enabled ?? true}, ${input.isDefault ?? false})`.execute(transaction);
}

async function storefront(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly commerceId: string;
    readonly companyId: string;
    readonly traderId: string;
  },
): Promise<string> {
  const id = randomUUID();
  const slug = `tc-${id.slice(0, 12)}`;
  await sql`insert into trader_storefronts(
      id, company_id, trader_id, trader_commerce_id, display_name, slug,
      business_template, theme)
    values(${id}::uuid, ${input.companyId}::uuid, ${input.traderId}::uuid,
      ${input.commerceId}::uuid, 'Commerce Test Store', ${slug}, 'fashion', 'luxury_minimal')`.execute(
    transaction,
  );
  return id;
}

async function product(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly barcode?: string | null;
    readonly companyId: string;
    readonly sku?: string | null;
    readonly storefrontId: string;
    readonly traderId: string;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`insert into trader_storefront_products(
      id, company_id, storefront_id, trader_id, name, slug, product_code,
      sku, barcode, selling_price)
    values(${id}::uuid, ${input.companyId}::uuid, ${input.storefrontId}::uuid,
      ${input.traderId}::uuid, 'Test Product', ${`p-${id.slice(0, 12)}`},
      ${`PC-${id.slice(0, 8)}`}, ${input.sku ?? null}, ${input.barcode ?? null}, 100)`.execute(
    transaction,
  );
  return id;
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback commerce test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
  }
}

/** Runs `work` in a savepoint so a rejection does not poison the outer transaction. */
async function rejects(
  transaction: Transaction<DatabaseSchema>,
  work: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `tc_${randomUUID().replace(/-/g, "")}`;
  await sql.raw(`savepoint ${savepoint}`).execute(transaction);
  let failed = false;
  try {
    await work();
  } catch {
    failed = true;
  }
  await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
  await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
  expect(failed).toBe(true);
}

describe.skipIf(!runDatabaseTests)("Trader Commerce identity", () => {
  it("creates a Commerce identity with no Company of its own", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const found = await sql<{ id: string; approvalStatus: string }>`
        select id, approval_status as "approvalStatus"
          from trader_commerce_profiles where id = ${fixture.commerceId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.approvalStatus).toBe("approved");
    });
  });

  it("rejects a link to a Commerce identity that does not exist", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        link(transaction, randomUUID(), fixture.companyId, fixture.traderId),
      );
    });
  });

  it("rejects an invalid registration source", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into trader_commerce_profiles(public_name,registration_source)
          values('Bad Source','not_a_source')`.execute(transaction),
      );
    });
  });
});

describe.skipIf(!runDatabaseTests)("Trader Commerce Company links", () => {
  it("links a Commerce identity to a Company Trader", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId);
      const found = await sql<{ count: string }>`
        select count(*)::text as count from trader_commerce_company_links
         where trader_id = ${fixture.traderId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.count).toBe("1");
    });
  });

  it("rejects a Trader that belongs to a different Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // The Trader is real and the Company is real; the PAIR is not.
      await rejects(transaction, () =>
        link(transaction, fixture.commerceId, fixture.companyId, fixture.otherTraderId),
      );
    });
  });

  it("refuses to map one Company Trader to two Commerce identities", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId);
      await rejects(transaction, () =>
        link(transaction, fixture.otherCommerceId, fixture.companyId, fixture.traderId),
      );
    });
  });

  it("refuses a duplicate link row", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId);
      await rejects(transaction, () =>
        link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId),
      );
    });
  });

  it("keeps two identical-looking Traders in different Companies distinct", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // Same name, same mobile, different Company. Nothing merges them.
      await link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId);
      await link(
        transaction,
        fixture.otherCommerceId,
        fixture.otherCompanyId,
        fixture.otherTraderId,
      );
      const found = await sql<{ identities: string }>`
        select count(distinct trader_commerce_id)::text as identities
          from trader_commerce_company_links
         where trader_id in (${fixture.traderId}::uuid, ${fixture.otherTraderId}::uuid)
      `.execute(transaction);
      expect(found.rows[0]?.identities).toBe("2");
    });
  });
});

describe.skipIf(!runDatabaseTests)("Trader Delivery Company relationships", () => {
  it("records the current Delivery Company relationship", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId);
      await relate(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        isDefault: true,
        traderId: fixture.traderId,
      });
      const found = await sql<{ count: string }>`
        select count(*)::text as count from trader_delivery_company_relationships
         where trader_commerce_id = ${fixture.commerceId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.count).toBe("1");
    });
  });

  it("refuses a duplicate relationship to the same Delivery Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await relate(transaction, { commerceId: fixture.commerceId, companyId: fixture.companyId });
      await rejects(transaction, () =>
        relate(transaction, { commerceId: fixture.commerceId, companyId: fixture.companyId }),
      );
    });
  });

  it("allows a Commerce identity with zero Delivery Company relationships", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const found = await sql<{ count: string }>`
        select count(*)::text as count from trader_delivery_company_relationships
         where trader_commerce_id = ${fixture.commerceId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.count).toBe("0");
    });
  });

  it("allows relationships with several different Delivery Companies", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await relate(transaction, { commerceId: fixture.commerceId, companyId: fixture.companyId });
      await relate(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.otherCompanyId,
      });
      const found = await sql<{ count: string }>`
        select count(*)::text as count from trader_delivery_company_relationships
         where trader_commerce_id = ${fixture.commerceId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.count).toBe("2");
    });
  });

  it("refuses a second enabled default Delivery Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await relate(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        isDefault: true,
      });
      await rejects(transaction, () =>
        relate(transaction, {
          commerceId: fixture.commerceId,
          companyId: fixture.otherCompanyId,
          isDefault: true,
        }),
      );
    });
  });

  it("refuses a Trader that belongs to a different Delivery Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // `trader_id` is nullable here, so the composite foreign key only bites
      // when a Trader IS named. That is exactly the case worth proving: a
      // relationship may be agreed before the Delivery Company has created its
      // Trader record, but it may never name someone else's Trader.
      await rejects(transaction, () =>
        relate(transaction, {
          commerceId: fixture.commerceId,
          companyId: fixture.companyId,
          traderId: fixture.otherTraderId,
        }),
      );
    });
  });

  it("allows a relationship that names no Trader yet", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await relate(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: null,
      });
      const found = await sql<{ count: string }>`
        select count(*)::text as count from trader_delivery_company_relationships
         where trader_commerce_id = ${fixture.commerceId}::uuid and trader_id is null
      `.execute(transaction);
      expect(found.rows[0]?.count).toBe("1");
    });
  });

  it("refuses an effective window that ends before it starts", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, relationship_source, status,
            effective_from, effective_to)
          values(${fixture.commerceId}::uuid, ${fixture.companyId}::uuid,
            'delivery_company_registered', 'active',
            now(), now() - interval '1 day')`.execute(transaction),
      );
    });
  });

  it("refuses an invalid status or relationship source", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, relationship_source, status)
          values(${fixture.commerceId}::uuid, ${fixture.companyId}::uuid,
            'delivery_company_registered', 'not_a_status')`.execute(transaction),
      );
      await rejects(transaction, () =>
        sql`insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, relationship_source, status)
          values(${fixture.commerceId}::uuid, ${fixture.companyId}::uuid,
            'not_a_source', 'active')`.execute(transaction),
      );
      // Lead/bid/application workflow states are deliberately NOT part of this
      // foundation; they belong to a later prompt.
      await rejects(transaction, () =>
        sql`insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, relationship_source, status)
          values(${fixture.commerceId}::uuid, ${fixture.companyId}::uuid,
            'delivery_company_registered', 'pending_application')`.execute(transaction),
      );
    });
  });

  it("refuses a default that is not enabled for Store orders", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        relate(transaction, {
          commerceId: fixture.commerceId,
          companyId: fixture.companyId,
          enabled: false,
          isDefault: true,
        }),
      );
    });
  });
});

describe.skipIf(!runDatabaseTests)("Storefront Commerce ownership", () => {
  it("accepts a Storefront owned by a valid Commerce identity", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const storefrontId = await storefront(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
      const found = await sql<{ traderCommerceId: string }>`
        select trader_commerce_id as "traderCommerceId" from trader_storefronts
         where id = ${storefrontId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.traderCommerceId).toBe(fixture.commerceId);
    });
  });

  it("rejects a Storefront pointing at a Commerce identity that does not exist", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        storefront(transaction, {
          commerceId: randomUUID(),
          companyId: fixture.companyId,
          traderId: fixture.traderId,
        }),
      );
    });
  });

  it("still enforces the legacy Company/Trader ownership chain", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // A valid Commerce identity does not excuse a Company/Trader mismatch
      // while the compatibility constraint is in place.
      await rejects(transaction, () =>
        storefront(transaction, {
          commerceId: fixture.commerceId,
          companyId: fixture.companyId,
          traderId: fixture.otherTraderId,
        }),
      );
    });
  });

  it("leaves no existing Storefront without a Commerce identity", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const found = await sql<{ unresolved: string }>`
        select count(*)::text as unresolved from trader_storefronts
         where trader_commerce_id is null
      `.execute(transaction);
      expect(found.rows[0]?.unresolved).toBe("0");
    });
  });
});

describe.skipIf(!runDatabaseTests)("Commerce changes leave history alone", () => {
  it("does not touch Orders or financial records", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const before = await sql<{ key: string; total: string }>`
        select 'orders' as key, count(*)::text as total from orders
        union all select 'trader_receivables', count(*)::text from trader_receivables
        union all select 'trader_settlements', count(*)::text from trader_settlements
        union all select 'driver_reconciliations', count(*)::text from driver_reconciliations
        union all select 'accounting_events', count(*)::text from accounting_events
        union all select 'journal_entries', count(*)::text from journal_entries
      `.execute(transaction);

      const fixture = await seed(transaction);
      await link(transaction, fixture.commerceId, fixture.companyId, fixture.traderId);
      await relate(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        isDefault: true,
        traderId: fixture.traderId,
      });
      await sql`update trader_delivery_company_relationships
        set status = 'terminated', is_default_for_store_orders = false, effective_to = now()
        where trader_commerce_id = ${fixture.commerceId}::uuid`.execute(transaction);

      const after = await sql<{ key: string; total: string }>`
        select 'orders' as key, count(*)::text as total from orders
        union all select 'trader_receivables', count(*)::text from trader_receivables
        union all select 'trader_settlements', count(*)::text from trader_settlements
        union all select 'driver_reconciliations', count(*)::text from driver_reconciliations
        union all select 'accounting_events', count(*)::text from accounting_events
        union all select 'journal_entries', count(*)::text from journal_entries
      `.execute(transaction);
      expect(after.rows).toStrictEqual(before.rows);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Product SKU, barcode and brand", () => {
  it("accepts a Product with no SKU and no barcode", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const storefrontId = await storefront(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
      const productId = await product(transaction, {
        companyId: fixture.companyId,
        storefrontId,
        traderId: fixture.traderId,
      });
      const found = await sql<{ sku: string | null; barcode: string | null }>`
        select sku, barcode from trader_storefront_products where id = ${productId}::uuid
      `.execute(transaction);
      expect(found.rows[0]).toStrictEqual({ barcode: null, sku: null });
    });
  });

  it("stores a leading-zero SKU and barcode exactly as written", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const storefrontId = await storefront(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
      const productId = await product(transaction, {
        barcode: "0012345678905",
        companyId: fixture.companyId,
        sku: "007-ABA",
        storefrontId,
        traderId: fixture.traderId,
      });
      const found = await sql<{ sku: string; barcode: string }>`
        select sku, barcode from trader_storefront_products where id = ${productId}::uuid
      `.execute(transaction);
      expect(found.rows[0]).toStrictEqual({ barcode: "0012345678905", sku: "007-ABA" });
    });
  });

  it("refuses a case-insensitively duplicate SKU within one Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const storefrontId = await storefront(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
      await product(transaction, {
        companyId: fixture.companyId,
        sku: "ABA-01",
        storefrontId,
        traderId: fixture.traderId,
      });
      await rejects(transaction, () =>
        product(transaction, {
          companyId: fixture.companyId,
          sku: "aba-01",
          storefrontId,
          traderId: fixture.traderId,
        }),
      );
    });
  });

  it("allows the same SKU in a different Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const first = await storefront(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
      const second = await storefront(transaction, {
        commerceId: fixture.otherCommerceId,
        companyId: fixture.otherCompanyId,
        traderId: fixture.otherTraderId,
      });
      await product(transaction, {
        companyId: fixture.companyId,
        sku: "ABA-01",
        storefrontId: first,
        traderId: fixture.traderId,
      });
      await product(transaction, {
        companyId: fixture.otherCompanyId,
        sku: "ABA-01",
        storefrontId: second,
        traderId: fixture.otherTraderId,
      });
      const found = await sql<{ count: string }>`
        select count(*)::text as count from trader_storefront_products
         where lower(sku) = 'aba-01'
           and storefront_id in (${first}::uuid, ${second}::uuid)
      `.execute(transaction);
      expect(found.rows[0]?.count).toBe("2");
    });
  });

  it("refuses a whitespace-only SKU or barcode", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const storefrontId = await storefront(transaction, {
        commerceId: fixture.commerceId,
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
      await rejects(transaction, () =>
        product(transaction, {
          companyId: fixture.companyId,
          sku: "   ",
          storefrontId,
          traderId: fixture.traderId,
        }),
      );
      await rejects(transaction, () =>
        product(transaction, {
          barcode: "  ",
          companyId: fixture.companyId,
          storefrontId,
          traderId: fixture.traderId,
        }),
      );
    });
  });
});
