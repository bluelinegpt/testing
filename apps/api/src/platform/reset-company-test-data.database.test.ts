import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { runReset } from "./reset-company-test-data.engine.js";
import { getResetCompanyUserPlan } from "./reset-company-users.js";

/**
 * Real-database proof for the reset execution engine.
 *
 * Everything runs inside ONE transaction that is always rolled back, so the test never
 * changes the development database. It builds two throwaway Companies with fresh UUIDs and
 * resets only the first, which is what makes the isolation assertion meaningful.
 *
 * Enable with RUN_RESET_DATABASE=true.
 */

const runDatabaseTests = process.env.RUN_RESET_DATABASE === "true";

interface Fixture {
  company: string;
  account: string;
  historyAccountB: string;
  historyAccountC: string;
  adminAccount: string;
  traderPortalAccountA: string;
  traderPortalAccountB: string;
  adminRole: string;
  adminSecondaryRole: string;
  memberRole: string;
  area: string;
  trader: string;
  customer: string;
  driver: string;
  order: string;
  finding: string;
  conversation: string;
  message: string;
  event: string;
  journal: string;
  fiscalYear: string;
  period: string;
}

async function seedCompany(client: pg.PoolClient, label: string): Promise<Fixture> {
  const fixture: Fixture = {
    company: randomUUID(),
    account: randomUUID(),
    historyAccountB: randomUUID(),
    historyAccountC: randomUUID(),
    adminAccount: randomUUID(),
    traderPortalAccountA: randomUUID(),
    traderPortalAccountB: randomUUID(),
    adminRole: randomUUID(),
    adminSecondaryRole: randomUUID(),
    memberRole: randomUUID(),
    area: randomUUID(),
    trader: randomUUID(),
    customer: randomUUID(),
    driver: randomUUID(),
    order: randomUUID(),
    finding: randomUUID(),
    conversation: randomUUID(),
    message: randomUUID(),
    event: randomUUID(),
    journal: randomUUID(),
    fiscalYear: randomUUID(),
    period: randomUUID(),
  };
  const suffix = fixture.company.slice(0, 8);
  const emirate = (await client.query<{ id: string }>("select id from emirates limit 1")).rows[0];
  if (emirate === undefined) {
    throw new Error("No emirates present; cannot seed the reset fixture");
  }

  await client.query(
    "insert into companies (id, code, subdomain, name_en, status, environment, activated_at) " +
      "values ($1, $2, $3, $4, 'active', 'development', now())",
    [
      fixture.company,
      `DEV-RST-${label}-${suffix}`,
      `dev-rst-${label.toLowerCase()}-${suffix}`,
      `Reset ${label}`,
    ],
  );
  await client.query(
    // Disabled so the fixture does not have to satisfy the active-user-needs-a-role guard.
    "insert into accounts (id, company_id, account_kind, username, normalized_username, " +
      "password_hash, status) values ($1, $2, 'company_user', $3, $3, 'x', 'disabled')",
    [fixture.account, fixture.company, `reset-${label}-${suffix}`],
  );
  await client.query(
    "insert into accounts (id, company_id, account_kind, username, normalized_username, " +
      "password_hash, status) values " +
      "($1, $3, 'company_user', $4, $4, 'x', 'disabled'), " +
      "($2, $3, 'company_user', $5, $5, 'x', 'disabled')",
    [
      fixture.historyAccountB,
      fixture.historyAccountC,
      fixture.company,
      `reset-history-b-${label}-${suffix}`,
      `reset-history-c-${label}-${suffix}`,
    ],
  );
  await client.query(
    "insert into accounts (id, company_id, account_kind, username, normalized_username, " +
      "password_hash, status) values ($1, $2, 'company_user', $3, $3, 'x', 'disabled')",
    [fixture.adminAccount, fixture.company, `reset-admin-${label}-${suffix}`],
  );
  // Trader Portal identities have a different account kind and no company_users
  // row. Both are active before reset, matching the accounts the previous
  // company_user-only cleanup accidentally left behind.
  await client.query(
    "insert into accounts (id, company_id, account_kind, username, normalized_username, " +
      "password_hash, status) values " +
      "($1, $3, 'trader', $4, $4, 'x', 'active'), ($2, $3, 'trader', $5, $5, 'x', 'active')",
    [
      fixture.traderPortalAccountA,
      fixture.traderPortalAccountB,
      fixture.company,
      `reset-trader-a-${suffix}`,
      `reset-trader-b-${suffix}`,
    ],
  );
  // This non-Admin Company user deliberately has no Employee row: user
  // selection must come from Company account/role assignments, not Employees.
  await client.query(
    "insert into company_users (company_id, account_id, name_en, display_name) " +
      "values ($1, $2, 'Reset Member A', 'Reset Member A'), ($1, $3, 'Reset Admin', 'Reset Admin'), " +
      "($1, $4, 'Reset Member B', 'Reset Member B'), ($1, $5, 'Reset Member C', 'Reset Member C')",
    [fixture.company, fixture.account, fixture.adminAccount, fixture.historyAccountB, fixture.historyAccountC],
  );
  await client.query(
    "insert into roles (id, company_id, code, name, is_system, is_active) values " +
      "($1, $4, 'company_admin', 'Company Administrator', true, true), " +
      "($2, $4, 'reset_admin_extra', 'Admin extra role', false, true), " +
      "($3, $4, 'reset_member', 'Reset member', false, true)",
    [fixture.adminRole, fixture.adminSecondaryRole, fixture.memberRole, fixture.company],
  );
  await client.query(
    "insert into role_permissions (role_id, permission_code) values " +
      "($1, 'users_roles.manage'), ($2, 'orders.create'), ($3, 'orders.create')",
    [fixture.adminRole, fixture.adminSecondaryRole, fixture.memberRole],
  );
  await client.query(
    "insert into account_roles (account_id, role_id, company_id) values " +
      "($1, $2, $3), ($4, $5, $3), ($4, $6, $3), ($7, $2, $3), ($8, $2, $3)",
    [fixture.account, fixture.memberRole, fixture.company, fixture.adminAccount, fixture.adminRole, fixture.adminSecondaryRole, fixture.historyAccountB, fixture.historyAccountC],
  );
  await client.query(
    "insert into account_sessions (company_id, account_id, token_hash, expires_at) " +
      "values ($1, $2, $3, now() + interval '1 day'), " +
      "($1, $4, $5, now() + interval '1 day'), " +
      "($1, $6, $7, now() + interval '1 day'), " +
      "($1, $8, $9, now() + interval '1 day')",
    [
      fixture.company,
      fixture.account,
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      fixture.adminAccount,
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      fixture.historyAccountB,
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      fixture.historyAccountC,
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
    ],
  );
  await client.query("insert into company_settings (company_id) values ($1)", [fixture.company]);
  await client.query(
    "insert into areas (id, company_id, code, name_en, emirate_id) values ($1, $2, $3, 'Area', $4)",
    [fixture.area, fixture.company, `A-${suffix}`, emirate.id],
  );
  await client.query(
    "insert into chart_of_accounts (id, company_id, code, name_en, account_type, account_class, " +
      "normal_balance) values ($1, $2, $3, 'Cash', 'asset', 'cash', 'debit')",
    [randomUUID(), fixture.company, `1000-${suffix}`],
  );
  await client.query(
    "insert into fiscal_years (id, company_id, fiscal_year_code, name, start_date, end_date, " +
      "status) values ($1, $2, $3, 'FY', '2026-01-01', '2026-12-31', 'open')",
    [fixture.fiscalYear, fixture.company, `FY-${suffix}`],
  );
  await client.query(
    "insert into accounting_periods (id, company_id, period_start, period_end, fiscal_year_id, " +
      "period_number, period_code, name, status) " +
      "values ($1, $2, '2026-01-01', '2026-01-31', $3, 1, $4, 'Jan', 'open')",
    [fixture.period, fixture.company, fixture.fiscalYear, `P-${suffix}`],
  );
  await client.query(
    "insert into audit_events " +
      "(id, company_id, action, subject_type, correlation_id, actor_account_id) " +
      "values ($1, $2, 'reset.fixture', 'test', $3, null), " +
      "($4, $2, 'reset.member.audit', 'test', $5, $6), " +
      "($7, $2, 'reset.member.audit', 'test', $8, $9), " +
      "($10, $2, 'reset.member.audit', 'test', $11, $12)",
    [
      randomUUID(), fixture.company, suffix,
      randomUUID(), `member-a-${suffix}`, fixture.account,
      randomUUID(), `member-b-${suffix}`, fixture.historyAccountB,
      randomUUID(), `member-c-${suffix}`, fixture.historyAccountC,
    ],
  );

  await client.query(
    "insert into traders (id, company_id, code, name_en, mobile_number) values ($1, $2, $3, $4, $5)",
    [fixture.trader, fixture.company, `T-${suffix}`, `Trader ${label}`, "971500000001"],
  );
  const portalTraderA = randomUUID();
  const portalTraderB = randomUUID();
  await client.query(
    "insert into traders (id, company_id, code, name_en, mobile_number) values " +
      "($1, $3, $4, 'Portal Trader A', '971500000011'), " +
      "($2, $3, $5, 'Portal Trader B', '971500000012')",
    [portalTraderA, portalTraderB, fixture.company, `TPA-${suffix}`, `TPB-${suffix}`],
  );
  const portalLinkA = randomUUID();
  const portalLinkB = randomUUID();
  const portalSessionA = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const portalSessionB = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await client.query(
    "insert into user_business_links " +
      "(id, company_id, account_id, entity_type, entity_id, access_status, is_primary, created_by_account_id) " +
      "values ($1, $3, $4, 'trader', $5, 'active', true, $6), " +
      "($2, $3, $7, 'trader', $8, 'active', true, $6)",
    [
      portalLinkA,
      portalLinkB,
      fixture.company,
      fixture.traderPortalAccountA,
      portalTraderA,
      fixture.adminAccount,
      fixture.traderPortalAccountB,
      portalTraderB,
    ],
  );
  await client.query(
    "insert into account_sessions " +
      "(company_id, account_id, token_hash, expires_at, profile_link_id, profile_type, profile_id) " +
      "values ($1, $2, $3, now() + interval '1 day', $4, 'trader', $5), " +
      "($1, $6, $7, now() + interval '1 day', $8, 'trader', $9)",
    [
      fixture.company,
      fixture.traderPortalAccountA,
      portalSessionA,
      portalLinkA,
      portalTraderA,
      fixture.traderPortalAccountB,
      portalSessionB,
      portalLinkB,
      portalTraderB,
    ],
  );
  await client.query(
    "insert into customers (id, company_id, code, name, mobile_number, created_by_account_id) " +
      "values ($1, $2, $3, $4, $5, $6)",
    [
      fixture.customer,
      fixture.company,
      `C-${suffix}`,
      `Customer ${label}`,
      "971500000002",
      fixture.account,
    ],
  );
  await client.query(
    "insert into drivers (id, company_id, code, name_en, mobile_number, driver_type, " +
      "outsourced_fee_per_delivered_order) values ($1, $2, $3, $4, $5, 'outsourced', 5)",
    [fixture.driver, fixture.company, `D-${suffix}`, `Driver ${label}`, "971500000003"],
  );
  await client.query(
    "insert into orders (id, company_id, order_number, order_date, trader_id, area_id, " +
      "created_by_account_id, customer_name, customer_mobile_number, customer_address, " +
      "package_count, payment_condition, final_service_fee_snapshot, " +
      "customer_provenance_status, pricing_provenance_status, service_fee) " +
      "values ($1, $2, $3, '2026-01-15', $4, $5, $6, 'Someone', '971500000004', 'Address', 1, " +
      "'customer_pays_cod_and_fee', 25, 'legacy_unattributed', 'legacy_unattributed', 25)",
    [
      fixture.order,
      fixture.company,
      `ORD-${suffix}`,
      fixture.trader,
      fixture.area,
      fixture.account,
    ],
  );
  await client.query(
    "insert into order_status_history (id, company_id, order_id, status_dimension, to_status, " +
      "changed_by_account_id) values ($1, $2, $3, 'delivery', 'new', $4)",
    [randomUUID(), fixture.company, fixture.order, fixture.account],
  );
  await client.query(
    "insert into order_maintenance_findings " +
      "(id, company_id, order_id, order_number, check_code, severity, evidence) " +
      "values ($1, $2, $3, $4, 'reset_fixture', 'warning', '{}'::jsonb)",
    [fixture.finding, fixture.company, fixture.order, `ORD-${suffix}`],
  );

  // Communication cycle: conversations.last_message_id <-> messages.conversation_id
  await client.query(
    "insert into conversations (id, company_id, conversation_type, participant_context_type, " +
      "created_by_account_id) values ($1, $2, 'general_support', 'trader', $3)",
    [fixture.conversation, fixture.company, fixture.account],
  );
  await client.query(
    "insert into messages (id, company_id, conversation_id, sender_role, message_type, " +
      "conversation_sequence, text_body) values ($1, $2, $3, 'office', 'text', 1, 'hello')",
    [fixture.message, fixture.company, fixture.conversation],
  );
  await client.query("update conversations set last_message_id = $1 where id = $2", [
    fixture.message,
    fixture.conversation,
  ]);

  // Accounting cycle: journal_entries.accounting_event_id <-> accounting_events.journal_id
  await client.query(
    "insert into accounting_events (id, company_id, event_type, event_version, " +
      "source_entity_type, source_entity_id, effective_accounting_date, correlation_id, " +
      "idempotency_key, event_hash, actor_type, description) " +
      "values ($1, $2, 'order_delivered', 1, 'order', $3, '2026-01-15', $4, $4, $4, 'system', 'x')",
    [fixture.event, fixture.company, fixture.order, `corr-${suffix}`],
  );
  await client.query(
    "insert into journal_entries (id, company_id, journal_number, accounting_period_id, " +
      "fiscal_year_id, business_date, source_type, description, created_by_account_id, " +
      "accounting_event_id) " +
      "values ($1, $2, $3, $4, $5, '2026-01-15', 'order', 'x', $6, $7)",
    [
      fixture.journal,
      fixture.company,
      `JE-${suffix}`,
      fixture.period,
      fixture.fiscalYear,
      fixture.account,
      fixture.event,
    ],
  );
  await client.query("update accounting_events set journal_id = $1 where id = $2", [
    fixture.journal,
    fixture.event,
  ]);

  return fixture;
}

interface PlatformFixture {
  avatarUsage: string;
  article: string;
  category: string;
  notFoundPath: string;
  relatedArticle: string;
}

async function seedPlatformData(client: pg.PoolClient): Promise<PlatformFixture> {
  const fixture = {
    avatarUsage: randomUUID(),
    article: randomUUID(),
    category: randomUUID(),
    notFoundPath: `/reset-fixture/${randomUUID()}`,
    relatedArticle: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const author = (
    await client.query<{ id: string }>("select id from platform_blog_authors limit 1")
  ).rows[0];
  if (author === undefined) {
    throw new Error("No Platform Blog author present; cannot seed preserved-data fixture");
  }

  const conversation = randomUUID();
  await client.query(
    "insert into platform_agent_conversations " +
      "(id, reference_number, public_session_token_hash, channel) " +
      "values ($1, $2, $3, 'website')",
    [conversation, `RST-${suffix}`, `reset-platform-${randomUUID()}`],
  );
  await client.query(
    "insert into platform_agent_live_avatar_usage (id, conversation_id, provider, language) " +
      "values ($1, $2, 'reset-test', 'en')",
    [fixture.avatarUsage, conversation],
  );
  await client.query(
    "insert into platform_blog_categories (id, name, slug, language) " +
      "values ($1, 'Reset fixture', $2, 'en')",
    [fixture.category, `reset-fixture-${suffix}`],
  );
  for (const [id, slug] of [
    [fixture.article, `reset-fixture-${suffix}-one`],
    [fixture.relatedArticle, `reset-fixture-${suffix}-two`],
  ]) {
    await client.query(
      "insert into platform_blog_articles " +
        "(id, slug, language, title, excerpt, author_id, category_id) " +
        "values ($1, $2, 'en', 'Reset fixture', 'Reset fixture', $3, $4)",
      [id, slug, author.id, fixture.category],
    );
  }
  await client.query(
    "insert into platform_blog_article_categories (article_id, category_id) values ($1, $2)",
    [fixture.article, fixture.category],
  );
  await client.query(
    "insert into platform_blog_article_relations " +
      "(article_id, related_article_id, relation_type) values ($1, $2, 'editorial')",
    [fixture.article, fixture.relatedArticle],
  );
  await client.query("insert into platform_public_not_found_paths (path) values ($1)", [
    fixture.notFoundPath,
  ]);
  return fixture;
}

async function countFor(client: pg.PoolClient, table: string, company: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::bigint as n from ${table} where company_id = $1`,
    [company],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe.skipIf(!runDatabaseTests)("reset execution engine against a real database", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  });

  it("resets one Company completely and leaves the other untouched", async () => {
    const client = await pool.connect();
    await client.query("begin");
    try {
      const alpha = await seedCompany(client, "A");
      const beta = await seedCompany(client, "B");
      const platform = await seedPlatformData(client);
      // Seeding queues deferred trigger events, and PostgreSQL refuses `alter table` while
      // any are pending. Real runs begin the transaction with the reset, so this only
      // affects the fixture; flushing here reproduces that clean starting state.
      await client.query("set constraints all immediate");

      const removedTables = [
        "order_maintenance_findings",
        "orders",
        "order_status_history",
        "customers",
        "traders",
        "drivers",
        "conversations",
        "messages",
        "accounting_events",
        "journal_entries",
      ];
      const preservedTables = [
        "accounts",
        "company_settings",
        "areas",
        "chart_of_accounts",
        "fiscal_years",
        "accounting_periods",
        "audit_events",
      ];

      for (const table of [...removedTables, ...preservedTables]) {
        expect(await countFor(client, table, alpha.company), `${table} seeded`).toBeGreaterThan(0);
      }

      const alphaUsers = await getResetCompanyUserPlan(client, alpha.company);
      expect(alphaUsers.usersToRemove.map((user) => user.accountId)).toEqual(
        expect.arrayContaining([alpha.account, alpha.historyAccountB, alpha.historyAccountC]),
      );
      expect(alphaUsers.usersToRemove.map((user) => user.accountId)).toContain(
        alpha.traderPortalAccountA,
      );
      expect(alphaUsers.usersToRemove.map((user) => user.accountId)).toContain(
        alpha.traderPortalAccountB,
      );
      expect(
        alphaUsers.usersToRemove
          .filter((user) => user.accountKind === "trader")
          .map((user) => user.accountId),
      ).toEqual(expect.arrayContaining([alpha.traderPortalAccountA, alpha.traderPortalAccountB]));
      expect(alphaUsers.adminUsersPreserved.map((user) => user.accountId)).toEqual([
        alpha.adminAccount,
      ]);
      const memberEmployee = await client.query(
        "select 1 from employees where company_id = $1 and company_user_id = $2",
        [alpha.company, alpha.account],
      );
      expect(memberEmployee.rowCount, "fixture user has no Employee record").toBe(0);

      const summary = await runReset(client, alpha.company, () => undefined);
      expect(summary.totalRemoved).toBeGreaterThan(0);
      expect(summary.userCleanup).toMatchObject({
        companyUsersRemoved: 3,
        roleAssignmentsRemoved: 3,
        businessAccessLinksRemoved: 2,
        sessionsRevoked: 5,
        accountsDeleted: 2,
        sharedIdentitiesPreserved: 0,
        historyReferencedIdentitiesPreserved: 3,
      });
      const userRemovalOrder = summary.removed.map((entry) => entry.table);
      expect(userRemovalOrder.indexOf("account_sessions")).toBeLessThan(
        userRemovalOrder.indexOf("account_roles"),
      );
      expect(userRemovalOrder.indexOf("account_roles")).toBeLessThan(
        userRemovalOrder.indexOf("company_users"),
      );
      expect(userRemovalOrder.indexOf("company_users")).toBeLessThan(
        userRemovalOrder.indexOf("accounts"),
      );
      const findingIndex = summary.removed.findIndex(
        (entry) => entry.table === "order_maintenance_findings",
      );
      const orderIndex = summary.removed.findIndex((entry) => entry.table === "orders");
      expect(findingIndex).toBeGreaterThanOrEqual(0);
      expect(findingIndex).toBeLessThan(orderIndex);

      // Transactional state and business masters are gone for the reset Company.
      for (const table of removedTables) {
        expect(await countFor(client, table, alpha.company), `${table} cleared`).toBe(0);
      }
      // Preserved configuration and audit survive.
      for (const table of preservedTables) {
        expect(await countFor(client, table, alpha.company), `${table} preserved`).toBeGreaterThan(
          0,
        );
      }
      // The other Company is completely untouched.
      for (const table of [...removedTables, ...preservedTables]) {
        expect(await countFor(client, table, beta.company), `${table} isolated`).toBeGreaterThan(0);
      }

      const removedMember = await client.query(
        "select (select count(*) from accounts where id = $1) as account_count, " +
          "(select count(*) from company_users where account_id = $1 and company_id = $2) as membership_count, " +
          "(select count(*) from account_roles where account_id = $1 and company_id = $2) as roles_count, " +
          "(select count(*) from account_sessions where account_id = $1 and company_id = $2) as sessions_count",
        [alpha.account, alpha.company],
      );
      expect(removedMember.rows[0]).toEqual({
        account_count: "1",
        membership_count: "0",
        roles_count: "0",
        sessions_count: "0",
      });
      const retainedMember = await client.query(
        "select status from accounts where id = $1 and company_id = $2",
        [alpha.account, alpha.company],
      );
      expect(retainedMember.rows[0]?.status).toBe("disabled");
      for (const retainedId of [alpha.account, alpha.historyAccountB, alpha.historyAccountC]) {
        expect(
          summary.userCleanup.retainedIdentities.find((user) => user.accountId === retainedId)
            ?.references,
        ).toContainEqual(
          expect.objectContaining({
            table: "audit_events",
            column: "actor_account_id",
            rows: 1,
            onDelete: "RESTRICT",
          }),
        );
      }
      // The retained audit anchor is not usable for sign-in: the login service
      // rejects non-active accountStatus, and the session-authentication query
      // can no longer find any unrevoked session for this account.
      const retainedAuthState = await client.query(
        "select a.status, " +
          "(select count(*) from account_sessions s where s.account_id=a.id and s.company_id=$2 " +
          "and s.revoked_at is null and s.expires_at>now()) as active_sessions, " +
          "(select count(*) from account_sessions s join accounts sa on sa.id=s.account_id " +
          "left join companies c on c.id=sa.company_id " +
          "where s.account_id=a.id and s.revoked_at is null and s.expires_at>now() " +
          "and sa.status='active' and (sa.company_id is null or c.status='active')) as authenticatable_sessions " +
          "from accounts a where a.id=$1",
        [alpha.account, alpha.company],
      );
      expect(retainedAuthState.rows[0]).toEqual({
        status: "disabled",
        active_sessions: "0",
        authenticatable_sessions: "0",
      });

      // The two active Trader Portal accounts are included despite having no
      // company_users row, and their logins, sessions, and profile grants go.
      const removedTraderPortals = await client.query(
        "select a.id, a.status, " +
          "(select count(*) from user_business_links l where l.account_id=a.id and l.company_id=$2) as links, " +
          "(select count(*) from account_sessions s where s.account_id=a.id and s.company_id=$2) as sessions " +
          "from accounts a where a.id = any($1::uuid[]) order by a.id",
        [[alpha.traderPortalAccountA, alpha.traderPortalAccountB], alpha.company],
      );
      expect(removedTraderPortals.rows).toEqual([]);
      const removedTraderPortalAccess = await client.query(
        "select " +
          "(select count(*) from user_business_links where account_id=any($1::uuid[]) and company_id=$2) as links, " +
          "(select count(*) from account_sessions where account_id=any($1::uuid[]) and company_id=$2) as sessions",
        [[alpha.traderPortalAccountA, alpha.traderPortalAccountB], alpha.company],
      );
      expect(removedTraderPortalAccess.rows[0]).toEqual({ links: "0", sessions: "0" });

      // History-only anchors have no current Company membership, role grant,
      // or portal link, so the operational Users list does not include them.
      const resetAccountsStillOperational = await client.query(
        "select a.id from accounts a where a.company_id=$1 and a.id=any($2::uuid[]) and (" +
          "exists (select 1 from company_users cu where cu.company_id=a.company_id and cu.account_id=a.id) " +
          "or exists (select 1 from account_roles ar where ar.company_id=a.company_id and ar.account_id=a.id) " +
          "or exists (select 1 from user_business_links l where l.company_id=a.company_id and l.account_id=a.id " +
          "and l.access_status in ('invited','active','suspended')))",
        [
          alpha.company,
          [alpha.account, alpha.historyAccountB, alpha.historyAccountC, alpha.traderPortalAccountA, alpha.traderPortalAccountB],
        ],
      );
      expect(resetAccountsStillOperational.rows).toEqual([]);

      // Admin preservation is based on the assigned role, even when the same
      // user has several roles; the profile, both grants, and session survive.
      const preservedAdmin = await client.query(
        "select (select count(*) from accounts where id = $1) as account_count, " +
          "(select count(*) from company_users where account_id = $1 and company_id = $2) as membership_count, " +
          "(select count(*) from account_roles where account_id = $1 and company_id = $2) as roles_count, " +
          "(select count(*) from account_sessions where account_id = $1 and company_id = $2 and revoked_at is null) as sessions_count",
        [alpha.adminAccount, alpha.company],
      );
      expect(preservedAdmin.rows[0]).toEqual({
        account_count: "1",
        membership_count: "1",
        roles_count: "2",
        sessions_count: "1",
      });

      // A different Company's non-Admin user, roles, and session remain intact.
      const otherCompanyUser = await client.query(
        "select (select count(*) from accounts where id = $1) as account_count, " +
          "(select count(*) from company_users where account_id = $1 and company_id = $2) as membership_count, " +
          "(select count(*) from account_roles where account_id = $1 and company_id = $2) as roles_count, " +
          "(select count(*) from account_sessions where account_id = $1 and company_id = $2 and revoked_at is null) as sessions_count",
        [beta.account, beta.company],
      );
      expect(otherCompanyUser.rows[0]).toEqual({
        account_count: "1",
        membership_count: "1",
        roles_count: "1",
        sessions_count: "1",
      });

      // Platform-wide content and telemetry are not company reset data. Verify
      // every synthetic global row remains after resetting alpha.
      const preservedPlatformRows = await client.query<{ table_name: string; n: string }>(
        "select 'platform_agent_live_avatar_usage' as table_name, count(*)::text as n " +
          "from platform_agent_live_avatar_usage where id = $1 " +
          "union all select 'platform_blog_article_categories', count(*)::text " +
          "from platform_blog_article_categories where article_id = $2 and category_id = $3 " +
          "union all select 'platform_blog_article_relations', count(*)::text " +
          "from platform_blog_article_relations where article_id = $2 and related_article_id = $4 " +
          "union all select 'platform_public_not_found_paths', count(*)::text " +
          "from platform_public_not_found_paths where path = $5",
        [
          platform.avatarUsage,
          platform.article,
          platform.category,
          platform.relatedArticle,
          platform.notFoundPath,
        ],
      );
      expect(preservedPlatformRows.rows).toEqual([
        { table_name: "platform_agent_live_avatar_usage", n: "1" },
        { table_name: "platform_blog_article_categories", n: "1" },
        { table_name: "platform_blog_article_relations", n: "1" },
        { table_name: "platform_public_not_found_paths", n: "1" },
      ]);

      // Both cycles were broken and both sides removed.
      expect(summary.cycleBreaks.map((entry) => entry.table).sort()).toEqual([
        "conversations",
        "journal_entries",
      ]);

      // Every suspended guard is enabled again, before any commit.
      const disabled = await client.query<{ tgname: string }>(
        "select tgname from pg_trigger where not tgisinternal and tgenabled <> 'O'",
      );
      expect(disabled.rows).toEqual([]);

      // Running it again is safe and removes nothing.
      const second = await runReset(client, alpha.company, () => undefined);
      expect(second.totalRemoved).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }, 120_000);

  it("refuses a non-development Company and changes nothing", async () => {
    const client = await pool.connect();
    await client.query("begin");
    try {
      const company = randomUUID();
      const suffix = company.slice(0, 8);
      // Deliberately no `environment` column here: this proves the CURRENT
      // guard (`runReset` refusing a non-development `environment`, see
      // reset-company-test-data.engine.ts) still refuses a Company that was
      // never marked as a development/test Company, using the schema's own
      // `production` default -- the same real-world shape as any Company
      // nobody has ever explicitly moved to a test environment. This test
      // used to assert an older `code` naming-convention guard
      // (`/not a DEV-\*/`) that no longer exists in the engine; updated to
      // assert the guard that replaced it.
      await client.query(
        "insert into companies (id, code, subdomain, name_en, status) " +
          "values ($1, $2, $3, 'Live', 'active')",
        [company, `LIVE-${suffix}`, `live-${suffix}`],
      );
      await expect(runReset(client, company, () => undefined)).rejects.toThrow(
        /environment is 'production'/,
      );

      const disabled = await client.query<{ tgname: string }>(
        "select tgname from pg_trigger where not tgisinternal and tgenabled <> 'O'",
      );
      expect(disabled.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }, 60_000);

  it("restores suspended guards when the transaction rolls back", async () => {
    const client = await pool.connect();
    await client.query("begin");
    try {
      await client.query("savepoint suspend_probe");
      await client.query("alter table orders disable trigger orders_assignment_consistency");
      const during = await client.query<{ tgenabled: string }>(
        "select tgenabled from pg_trigger where tgname = 'orders_assignment_consistency'",
      );
      expect(during.rows[0]?.tgenabled).toBe("D");

      await client.query("rollback to savepoint suspend_probe");
      const after = await client.query<{ tgenabled: string }>(
        "select tgenabled from pg_trigger where tgname = 'orders_assignment_consistency'",
      );
      expect(after.rows[0]?.tgenabled).toBe("O");
    } finally {
      await client.query("rollback");
      client.release();
    }
  }, 60_000);
});
