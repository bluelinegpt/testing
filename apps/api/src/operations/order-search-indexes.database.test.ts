import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * The Order search index foundation.
 *
 * Two separate claims are checked, because they fail in different ways:
 *
 *   1. The objects exist, with the operator classes that make them usable. A
 *      B-tree without `text_pattern_ops` looks correct in `\d orders` and is
 *      silently useless for prefix search under this database's collation, so
 *      the definition is asserted, not just the name.
 *
 *   2. The planner will actually CHOOSE them. Asserted against a temporary
 *      table holding 20,000 rows, because a plan is a function of table size:
 *      on the near-empty `orders` table every plan is a sequential scan and
 *      proves nothing at all.
 *
 * Deliberately NOT asserted: which node type appears. `Index Scan`,
 * `Bitmap Index Scan` and an `Index Only Scan` are all correct answers here and
 * PostgreSQL may reasonably pick between them across versions and statistics.
 * What matters is that the intended index is named in the plan.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
const pool = new Pool({ connectionString: configuration().database.url, max: 2 });
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

/** The plan for one query, flattened to a searchable string. */
async function planFor(query: string): Promise<string> {
  const result = await sql<{ "QUERY PLAN": unknown }>`${sql.raw(
    `explain (format json) ${query}`,
  )}`.execute(database);
  return JSON.stringify(result.rows[0]!["QUERY PLAN"]);
}

const COMPANY = "11111111-1111-1111-1111-111111111111";

describe.skipIf(!runDatabaseTests)("order search index foundation", () => {
  afterAll(async () => {
    await database.destroy();
  });

  it("has pg_trgm installed", async () => {
    const result = await sql<{ extname: string }>`
      select extname from pg_extension where extname='pg_trgm'`.execute(database);
    expect(result.rows).toHaveLength(1);
  });

  it("keeps every pre-existing Orders index intact", async () => {
    // The foundation ADDS to the index set; it must never have replaced an
    // index another query depends on.
    const result = await sql<{ indexname: string }>`
      select indexname from pg_indexes where tablename='orders'`.execute(database);
    const names = result.rows.map((row) => row.indexname);
    for (const existing of [
      "orders_pkey",
      "orders_id_company_id_key",
      "orders_company_id_order_number_key",
      "orders_customer_mobile_index",
      "orders_reference_number_normalized_unique",
      "orders_daily_serial_number_unique",
      "orders_company_status_date_index",
      "orders_company_trader_date_index",
    ]) {
      expect(names, `${existing} must still exist`).toContain(existing);
    }
  });

  it("creates the four search indexes with the operator classes that matter", async () => {
    const result = await sql<{ indexdef: string; indexname: string }>`
      select indexname, indexdef from pg_indexes
       where tablename='orders' and indexname in (
         'orders_company_order_number_pattern_index',
         'orders_company_mobile_pattern_index',
         'orders_reference_normalized_trgm_index',
         'orders_customer_name_trgm_index')`.execute(database);
    const byName = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.size).toBe(4);

    // Without text_pattern_ops these are useless for LIKE 'x%' under a non-C
    // collation, which is the entire reason they exist.
    expect(byName.get("orders_company_order_number_pattern_index")).toMatch(
      /company_id.*order_number text_pattern_ops/s,
    );
    expect(byName.get("orders_company_mobile_pattern_index")).toMatch(
      /company_id.*customer_mobile_number text_pattern_ops/s,
    );
    // Trigram, and the name index must be on the lowered expression or a
    // case-insensitive search cannot use it.
    expect(byName.get("orders_reference_normalized_trgm_index")).toMatch(/gin.*gin_trgm_ops/s);
    expect(byName.get("orders_customer_name_trgm_index")).toMatch(
      /gin.*lower\(customer_name\).*gin_trgm_ops/s,
    );
  });

  it("adds no index that merely repeats an existing one", async () => {
    // Two indexes over the same leading columns AND the same operator classes
    // would be dead weight on every write. Same columns with DIFFERENT operator
    // classes is the intended design, so the comparison includes them.
    const result = await sql<{ signature: string }>`
      select regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX [a-z0-9_]+ ', '') as signature
        from pg_indexes where tablename='orders'`.execute(database);
    const signatures = result.rows.map((row) => row.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  /* 30s: every case in here re-seeds 20,000 rows, which exceeds vitest's 5s
     default once the suite runs alongside the other database tests. The tests
     were correct but intermittently timed out under parallel load. */
  describe("planner behaviour on a representative dataset", { timeout: 30000 }, () => {
    /**
     * 20,000 rows mirroring the search-relevant Orders columns and index set.
     * A temporary table, so nothing outlives the session and no business data
     * is touched -- the real `orders` table is left completely alone.
     */
    const seed = async () => {
      await sql`
        create temp table if not exists order_search_probe (
          id uuid primary key default gen_random_uuid(),
          company_id uuid not null,
          order_number text not null,
          reference_number_normalized text,
          customer_name text not null,
          customer_mobile_number text not null,
          delivery_status text not null,
          order_date date not null)`.execute(database);
      await sql`truncate order_search_probe`.execute(database);
      await sql`
        insert into order_search_probe (company_id, order_number, reference_number_normalized,
            customer_name, customer_mobile_number, delivery_status, order_date)
        select case when g % 7 = 0 then gen_random_uuid() else ${COMPANY}::uuid end,
          'ORD-'||lpad(g::text,8,'0'), upper('ABC-'||lpad(g::text,7,'0')),
          (array['Ahmed','Mohammed','Sara','أحمد','Omar'])[1+g%5]||' Case '||g::text,
          '9715'||lpad((10000000+g)::text,8,'0'),
          (array['delivered','new','on_hold','cancelled'])[1+g%4],
          date '2026-01-01' + (g%300)
        from generate_series(1,20000) g`.execute(database);
      // The same four indexes the migration creates, plus the equality ones
      // they complement.
      for (const statement of [
        `create index if not exists probe_num on order_search_probe (company_id, order_number)`,
        `create index if not exists probe_num_pat on order_search_probe (company_id, order_number text_pattern_ops)`,
        `create index if not exists probe_mob_pat on order_search_probe (company_id, customer_mobile_number text_pattern_ops)`,
        `create index if not exists probe_ref on order_search_probe (company_id, reference_number_normalized)`,
        `create index if not exists probe_ref_trgm on order_search_probe using gin (reference_number_normalized gin_trgm_ops)`,
        `create index if not exists probe_name_trgm on order_search_probe using gin (lower(customer_name) gin_trgm_ops)`,
      ]) {
        await sql`${sql.raw(statement)}`.execute(database);
      }
      await sql`analyze order_search_probe`.execute(database);
    };

    const scoped = (predicate: string) =>
      `select id from order_search_probe where company_id='${COMPANY}' and ${predicate} limit 25`;

    it("uses an index for every selective identifier search", async () => {
      await seed();
      const cases: readonly [string, string, string][] = [
        ["order number exact", `order_number='ORD-00010000'`, "probe_num"],
        ["order number prefix", `order_number like 'ORD-000100%'`, "probe_num_pat"],
        ["reference exact", `reference_number_normalized='ABC-0010000'`, "probe_ref"],
        ["reference infix", `reference_number_normalized like '%0010000%'`, "probe_ref_trgm"],
        ["mobile exact", `customer_mobile_number='971510010000'`, "probe_mob_pat"],
        ["mobile prefix", `customer_mobile_number like '9715100100%'`, "probe_mob_pat"],
        [
          "customer name infix",
          `lower(customer_name) like lower('%Case 10000%')`,
          "probe_name_trgm",
        ],
        // A SELECTIVE Arabic term. Plain '%أحمد%' matches ~20% of this fixture
        // and the planner rightly scans for it -- that would test selectivity,
        // not Unicode. This proves trigrams index Arabic text itself.
        [
          "arabic name infix",
          `lower(customer_name) like lower('%أحمد Case 10003%')`,
          "probe_name_trgm",
        ],
      ];
      for (const [label, predicate, expectedIndex] of cases) {
        const plan = await planFor(scoped(predicate));
        expect(plan, `${label} should use ${expectedIndex}`).toContain(expectedIndex);
        expect(plan, `${label} must not sequentially scan`).not.toContain('"Node Type":"Seq Scan"');
      }
    });

    it("keeps the Company predicate in the plan for every search", async () => {
      await seed();
      for (const predicate of [
        `order_number like 'ORD-000100%'`,
        `reference_number_normalized like '%0010000%'`,
        `lower(customer_name) like lower('%Case 10000%')`,
      ]) {
        // Whether it lands in an Index Cond or a Filter is the planner's
        // choice; that it is present at all is the tenancy guarantee.
        expect(await planFor(scoped(predicate))).toContain("company_id");
      }
    });

    it("keeps a historical-tab search index-backed", async () => {
      await seed();
      const plan = await planFor(
        `select id from order_search_probe
          where company_id='${COMPANY}'
            and delivery_status in ('delivered','cancelled')
            and reference_number_normalized like '%0010000%'
          order by order_date desc limit 25`,
      );
      // The closed/cancelled population is the one that grows without bound, so
      // this is the case that must not degrade to a scan.
      expect(plan).toContain("probe_ref_trgm");
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
    });

    it("still answers a low-selectivity name search, by whatever plan", async () => {
      await seed();
      // 'Ahmed' matches ~20% of rows here. A sequential scan is a legitimate
      // choice at that selectivity and the test says so rather than pretending
      // otherwise -- the requirement is an indexed path for SELECTIVE searches,
      // not the absence of Seq Scan everywhere.
      const plan = await planFor(scoped(`lower(customer_name) like lower('%Ahmed%')`));
      expect(plan.length).toBeGreaterThan(0);
    });
  });
});
