import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { config } = require("dotenv");
const pg = require("pg");

config({ path: ".env" });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const orders = await client.query(`
    select md5(string_agg(row_to_json(snapshot)::text, '|' order by snapshot.order_number)) as hash,
           count(*)::int as count
    from (
      select order_number, cod_amount, service_fee, vat_amount, customer_amount_due,
             trader_net_payable, company_revenue, order_profit
      from orders
    ) snapshot
  `);
  const reconciliation = await client.query(`
    select row_to_json(snapshot) as value
    from (
      select reconciliation_number, status, gross_collections, driver_payable_deduction,
             reconciliation_expenses, net_amount_received
      from driver_reconciliations
      where reconciliation_number = 'REC-000001'
    ) snapshot
  `);
  console.log(
    JSON.stringify({
      orders: orders.rows[0],
      reconciliation: reconciliation.rows[0]?.value ?? null,
    }),
  );
} finally {
  await client.end();
}
