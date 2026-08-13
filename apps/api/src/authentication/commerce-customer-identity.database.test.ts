import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Shared Commerce Foundation Prompt 3A: the marketplace Customer identity
 * foundation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM `authentication.database.test.ts`
 * ---------------------------------------------------------------------------
 *
 * This proves the ONE schema change 3A makes -- `accounts_kind_check`/
 * `accounts_scope_check` widened to allow a Company-less `customer` kind --
 * is narrow: every OTHER kind's Company requirement is completely
 * unchanged. §59's mandatory five-way test lives here specifically so a
 * future regression in the scope check shows up as a Customer-identity
 * failure, not buried inside an unrelated Company-auth test file.
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const rollback = Symbol("rollback commerce customer identity test");
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

async function seedCompany(transaction: Transaction<DatabaseSchema>) {
  const companyId = randomUUID();
  const suffix = companyId.slice(0, 8);
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values(${companyId}::uuid, ${`CID-${suffix}`}, ${`cid-${suffix}`}, 'Scope Check Co', 'active', now())`.execute(
    transaction,
  );
  return companyId;
}

/**
 * §59 -- proves `accounts_scope_check` was widened narrowly: exactly two
 * kinds (`platform_administrator`, `customer`) may now have a null Company,
 * and every other existing kind still requires one, unchanged.
 */
describe.skipIf(!runDatabaseTests)("accounts_scope_check narrowing (Prompt 3A)", () => {
  it("still allows a Platform Administrator with a null Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const id = randomUUID();
      await expect(
        sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
          values(${id}::uuid, null, 'platform_administrator', ${`pa-${id}`}, ${`pa-${id}`}, 'x')`.execute(
          transaction,
        ),
      ).resolves.toBeDefined();
    });
  });

  it("now allows a customer with a null Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const id = randomUUID();
      await expect(
        sql`insert into accounts(
            id, company_id, account_kind, username, normalized_username, password_hash,
            mobile_number, normalized_mobile_number
          ) values(
            ${id}::uuid, null, 'customer', ${`cust-${id}`}, ${`cust-${id}`}, 'x',
            '971501112233', '971501112233'
          )`.execute(transaction),
      ).resolves.toBeDefined();
    });
  });

  it("still rejects a Company user with a null Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const id = randomUUID();
      await expect(
        sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
          values(${id}::uuid, null, 'company_user', ${`cu-${id}`}, ${`cu-${id}`}, 'x')`.execute(
          transaction,
        ),
      ).rejects.toThrow();
    });
  });

  it("still rejects a Trader with a null Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const id = randomUUID();
      await expect(
        sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
          values(${id}::uuid, null, 'trader', ${`tr-${id}`}, ${`tr-${id}`}, 'x')`.execute(transaction),
      ).rejects.toThrow();
    });
  });

  it("still rejects a Driver with a null Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const id = randomUUID();
      await expect(
        sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
          values(${id}::uuid, null, 'driver', ${`dr-${id}`}, ${`dr-${id}`}, 'x')`.execute(transaction),
      ).rejects.toThrow();
    });
  });

  it("still requires an actual Company for a Company-scoped kind with one supplied", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyId = await seedCompany(transaction);
      const id = randomUUID();
      await expect(
        sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
          values(${id}::uuid, ${companyId}::uuid, 'company_user', ${`cu2-${id}`}, ${`cu2-${id}`}, 'x')`.execute(
          transaction,
        ),
      ).resolves.toBeDefined();
    });
  });

  it("rejects a customer account that is also given a Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyId = await seedCompany(transaction);
      const id = randomUUID();
      await expect(
        sql`insert into accounts(
            id, company_id, account_kind, username, normalized_username, password_hash,
            mobile_number, normalized_mobile_number
          ) values(
            ${id}::uuid, ${companyId}::uuid, 'customer', ${`cust2-${id}`}, ${`cust2-${id}`}, 'x',
            '971501112244', '971501112244'
          )`.execute(transaction),
      ).rejects.toThrow();
    });
  });

  it("rejects a customer account with no mobile number", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const id = randomUUID();
      await expect(
        sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
          values(${id}::uuid, null, 'customer', ${`cust3-${id}`}, ${`cust3-${id}`}, 'x')`.execute(
          transaction,
        ),
      ).rejects.toThrow();
    });
  });
});

/**
 * §60/§11 -- the Commerce Customer identity model itself: creation, the
 * account-scope guard trigger, and global (Company-less) mobile/email
 * uniqueness.
 */
describe.skipIf(!runDatabaseTests)("commerce_customers identity (Prompt 3A)", () => {
  async function insertCustomerAccount(
    transaction: Transaction<DatabaseSchema>,
    input: { readonly email?: string; readonly mobile: string },
  ) {
    const id = randomUUID();
    await sql`insert into accounts(
        id, company_id, account_kind, username, normalized_username, password_hash,
        mobile_number, normalized_mobile_number, email, normalized_email
      ) values(
        ${id}::uuid, null, 'customer', ${input.mobile}, ${input.mobile}, 'x',
        ${input.mobile}, ${input.mobile},
        ${input.email ?? null}, ${input.email?.toLowerCase() ?? null}
      )`.execute(transaction);
    return id;
  }

  it("creates a Commerce Customer profile linked to a Company-less customer account", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const accountId = await insertCustomerAccount(transaction, { mobile: "971501230001" });
      const customerId = randomUUID();
      await sql`insert into commerce_customers(id, account_id, name, mobile_number)
        values(${customerId}::uuid, ${accountId}::uuid, 'Dev Customer', '971501230001')`.execute(
        transaction,
      );
      const row = await sql<{ accountId: string }>`
        select account_id as "accountId" from commerce_customers where id = ${customerId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.accountId).toBe(accountId);

      // No Delivery `customers` row is created as a side effect.
      const deliveryCount = await sql<{ count: string }>`
        select count(*)::text as count from customers where mobile_number = '971501230001'
      `.execute(transaction);
      expect(deliveryCount.rows[0]?.count).toBe("0");
    });
  });

  it("rejects a Commerce Customer linked to a Company-scoped account", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyId = await seedCompany(transaction);
      const accountId = randomUUID();
      await sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
        values(${accountId}::uuid, ${companyId}::uuid, 'company_user', ${`cu3-${accountId}`}, ${`cu3-${accountId}`}, 'x')`.execute(
        transaction,
      );
      await expect(
        sql`insert into commerce_customers(id, account_id, name, mobile_number)
          values(${randomUUID()}::uuid, ${accountId}::uuid, 'Wrong Kind', '971501230002')`.execute(
          transaction,
        ),
      ).rejects.toThrow(/must reference a Company-less customer account/);
    });
  });

  it("enforces one Commerce Customer per Account", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const accountId = await insertCustomerAccount(transaction, { mobile: "971501230003" });
      await sql`insert into commerce_customers(id, account_id, name, mobile_number)
        values(${randomUUID()}::uuid, ${accountId}::uuid, 'First', '971501230003')`.execute(
        transaction,
      );
      await expect(
        sql`insert into commerce_customers(id, account_id, name, mobile_number)
          values(${randomUUID()}::uuid, ${accountId}::uuid, 'Second', '971501230003')`.execute(
          transaction,
        ),
      ).rejects.toThrow();
    });
  });

  it("enforces global mobile uniqueness across customer accounts", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await insertCustomerAccount(transaction, { mobile: "971501230004" });
      await expect(insertCustomerAccount(transaction, { mobile: "971501230004" })).rejects.toThrow();
    });
  });

  it("enforces case-insensitive global email uniqueness across customer accounts", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await insertCustomerAccount(transaction, {
        email: "shopper@example.test",
        mobile: "971501230005",
      });
      await expect(
        insertCustomerAccount(transaction, {
          email: "Shopper@Example.Test",
          mobile: "971501230006",
        }),
      ).rejects.toThrow();
    });
  });

  it("allows the same mobile to be used by a Delivery customer and a marketplace Customer independently", async () => {
    await inRolledBackTransaction(async (transaction) => {
      // Proves §3: no cross-domain identity inference. A Delivery Company's
      // own `customers` row and a marketplace Customer account are
      // unrelated tables with no shared uniqueness constraint.
      const companyId = await seedCompany(transaction);
      const actorId = randomUUID();
      await sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
        values(${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`cu4-${actorId}`}, ${`cu4-${actorId}`}, 'x')`.execute(
        transaction,
      );
      await sql`insert into customers(id, company_id, code, name, mobile_number, created_by_account_id)
        values(${randomUUID()}::uuid, ${companyId}::uuid, ${`CUS-${actorId.slice(0, 8)}`}, 'Delivery Recipient',
          '971501230007', ${actorId}::uuid)`.execute(transaction);

      await expect(insertCustomerAccount(transaction, { mobile: "971501230007" })).resolves.toBeDefined();
    });
  });
});

/**
 * §16/§61 -- address ownership: default handling and the Cascade delete
 * when a Customer is removed (no orphaned address rows).
 */
describe.skipIf(!runDatabaseTests)("commerce_customer_addresses ownership (Prompt 3A)", () => {
  async function seedCustomer(transaction: Transaction<DatabaseSchema>, mobile: string) {
    const accountId = randomUUID();
    await sql`insert into accounts(
        id, company_id, account_kind, username, normalized_username, password_hash,
        mobile_number, normalized_mobile_number
      ) values(${accountId}::uuid, null, 'customer', ${mobile}, ${mobile}, 'x', ${mobile}, ${mobile})`.execute(
      transaction,
    );
    const customerId = randomUUID();
    await sql`insert into commerce_customers(id, account_id, name, mobile_number)
      values(${customerId}::uuid, ${accountId}::uuid, 'Dev Customer', ${mobile})`.execute(transaction);
    return customerId;
  }

  it("allows only one default Address per Customer", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const customerId = await seedCustomer(transaction, "971501230010");
      await sql`insert into commerce_customer_addresses(
          id, commerce_customer_id, recipient_name, mobile_number, emirate, address, is_default
        ) values(${randomUUID()}::uuid, ${customerId}::uuid, 'Dev Customer', '971501230010', 'Dubai', 'Deira', true)`.execute(
        transaction,
      );
      await expect(
        sql`insert into commerce_customer_addresses(
            id, commerce_customer_id, recipient_name, mobile_number, emirate, address, is_default
          ) values(${randomUUID()}::uuid, ${customerId}::uuid, 'Dev Customer', '971501230010', 'Dubai', 'Marina', true)`.execute(
          transaction,
        ),
      ).rejects.toThrow();
    });
  });

  it("allows a second, non-default Address alongside the default", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const customerId = await seedCustomer(transaction, "971501230011");
      await sql`insert into commerce_customer_addresses(
          id, commerce_customer_id, recipient_name, mobile_number, emirate, address, is_default
        ) values(${randomUUID()}::uuid, ${customerId}::uuid, 'Dev Customer', '971501230011', 'Dubai', 'Deira', true)`.execute(
        transaction,
      );
      await expect(
        sql`insert into commerce_customer_addresses(
            id, commerce_customer_id, recipient_name, mobile_number, emirate, address, is_default
          ) values(${randomUUID()}::uuid, ${customerId}::uuid, 'Dev Customer', '971501230011', 'Dubai', 'Marina', false)`.execute(
          transaction,
        ),
      ).resolves.toBeDefined();
    });
  });

  it("deletes a Customer's addresses when the Customer itself is deleted (no orphans)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const customerId = await seedCustomer(transaction, "971501230012");
      const addressId = randomUUID();
      await sql`insert into commerce_customer_addresses(
          id, commerce_customer_id, recipient_name, mobile_number, emirate, address, is_default
        ) values(${addressId}::uuid, ${customerId}::uuid, 'Dev Customer', '971501230012', 'Dubai', 'Deira', true)`.execute(
        transaction,
      );
      await sql`delete from commerce_customers where id = ${customerId}::uuid`.execute(transaction);
      const remaining = await sql<{ count: string }>`
        select count(*)::text as count from commerce_customer_addresses where id = ${addressId}::uuid
      `.execute(transaction);
      expect(remaining.rows[0]?.count).toBe("0");
    });
  });
});

/**
 * §62 -- the existing Delivery `customers`/`customer_addresses` tables must
 * be completely untouched by this migration: `company_id` still required,
 * no auth column added.
 */
describe.skipIf(!runDatabaseTests)("Delivery customer regression (Prompt 3A)", () => {
  it("still requires company_id on customers", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const actorId = randomUUID();
      await expect(
        sql`insert into customers(id, company_id, code, name, mobile_number, created_by_account_id)
          values(${randomUUID()}::uuid, null, 'REG-1', 'No Company', '971501230099', ${actorId}::uuid)`.execute(
          transaction,
        ),
      ).rejects.toThrow();
    });
  });

  it("still requires company_id on customer_addresses", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyId = await seedCompany(transaction);
      const actorId = randomUUID();
      await sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
        values(${actorId}::uuid, ${companyId}::uuid, 'company_user', ${`cu5-${actorId}`}, ${`cu5-${actorId}`}, 'x')`.execute(
        transaction,
      );
      const customerId = randomUUID();
      await sql`insert into customers(id, company_id, code, name, mobile_number, created_by_account_id)
        values(${customerId}::uuid, ${companyId}::uuid, 'REG-2', 'Has Company', '971501230098', ${actorId}::uuid)`.execute(
        transaction,
      );
      const areaId = randomUUID();
      const emirate = await sql<{ id: string }>`select id from emirates where code = 'DXB'`.execute(
        transaction,
      );
      await sql`insert into areas(id, company_id, emirate_id, code, name_en)
        values(${areaId}::uuid, ${companyId}::uuid, ${emirate.rows[0]!.id}::uuid, 'A-REG', 'Area Reg')`.execute(
        transaction,
      );
      await expect(
        sql`insert into customer_addresses(id, company_id, customer_id, area_id, address)
          values(${randomUUID()}::uuid, null, ${customerId}::uuid, ${areaId}::uuid, 'Deira')`.execute(
          transaction,
        ),
      ).rejects.toThrow();
    });
  });

  it("has no password/auth column on customers", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const columns = await sql<{ columnName: string }>`
        select column_name as "columnName" from information_schema.columns
         where table_name = 'customers'
      `.execute(transaction);
      const names = columns.rows.map((row) => row.columnName);
      expect(names).not.toContain("password_hash");
      expect(names).not.toContain("account_id");
    });
  });
});
