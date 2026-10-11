import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { runReset } from "./reset-company-test-data.engine.js";
import { moduleOf, PRESERVE_TABLES, PURGE_TABLES } from "./reset-company-test-data.manifest.js";
import { domainCoverageProblems } from "./company-data-reset.domains.js";
import { assertDisposableDatabase } from "./company-data-reset.fixture.js";
import { getResetCompanyUserPlan, RESET_USER_MUTABLE_TABLES } from "./reset-company-users.js";

/**
 * COMPANY DATA RESET -- non-negotiable requirements, compatibility guards
 * (Phase 2 Prompt 5; requirements recorded in
 * docs/architecture/company-data-reset-requirements.md).
 *
 * These tests pin the architecture that keeps the requirements POSSIBLE:
 * a reset is never "DELETE everything WHERE company_id = X". Identity and
 * configuration tables are never in the purge set, Platform audit history is
 * always preserved, Platform administrators are never reset candidates, and
 * every purgeable table belongs to a named module so presets can select by
 * module. Requirements the current implementation does not yet meet are
 * listed as `todo` (they are reported gaps, not silently passing tests).
 */

/** Identity / access tables: only ever changed by the selective user step. */
const IDENTITY_TABLES = [
  "accounts",
  "company_users",
  "account_roles",
  "account_sessions",
  "password_reset_tokens",
  "user_business_links",
  "roles",
  "role_permissions",
];

/** Company configuration that every reset preset must keep. */
const CONFIGURATION_TABLES = [
  "company_settings",
  "areas",
  "chart_of_accounts",
  "accounting_configurations",
  "company_cash_accounts",
];

/** Gap R8: purge tables not yet mapped to a reset module (must shrink, never grow). */
const KNOWN_UNASSIGNED_PURGE_TABLES = [
  "commerce_integration_area_mappings",
  "commerce_integration_connections",
  "commerce_integration_events",
  "commerce_integration_oauth_states",
  "commerce_integration_order_links",
  "company_whatsapp_connections",
  "device_registrations",
  "hr_document_attachments",
  "hr_documents",
  "idempotency_records",
  "notification_outbox_events",
  "platform_fee_payments",
  "platform_fee_receivables",
  "trader_credits",
  "trader_whatsapp_settings",
  "whatsapp_message_attempts",
  "whatsapp_message_outbox",
];

/** Platform administrative audit: preserved regardless of the reset chosen. */
const PLATFORM_AUDIT_TABLES = ["platform_repair_executions", "platform_repair_attempts", "audit_events"];

describe("Company Data Reset requirements -- manifest compatibility", () => {
  it("is never a blind company-wide delete: identity tables are not purge targets", () => {
    for (const table of IDENTITY_TABLES) {
      expect(PURGE_TABLES.has(table), `${table} must not be purged wholesale`).toBe(false);
      expect(PRESERVE_TABLES.has(table), `${table} must be classified PRESERVE`).toBe(true);
    }
    // The selective user step may touch identity rows; nothing else may.
    for (const table of RESET_USER_MUTABLE_TABLES) {
      expect(PRESERVE_TABLES.has(table)).toBe(true);
      expect(PURGE_TABLES.has(table)).toBe(false);
    }
  });

  it("keeps the Company's configuration", () => {
    for (const table of CONFIGURATION_TABLES) {
      expect(PURGE_TABLES.has(table), `${table} is configuration`).toBe(false);
      expect(PRESERVE_TABLES.has(table)).toBe(true);
    }
  });

  it("preserves Platform repair and administrative audit history regardless of reset", () => {
    for (const table of PLATFORM_AUDIT_TABLES) {
      expect(PRESERVE_TABLES.has(table)).toBe(true);
      expect(PURGE_TABLES.has(table)).toBe(false);
      expect(moduleOf(table)).toBe("Audit");
    }
  });

  it("every purgeable table belongs to a named module, so presets can select by module", () => {
    const unassigned = [...PURGE_TABLES].filter((table) => moduleOf(table) === "Other").sort();
    // Presets (Operational / Financial / Users-Employees / Full / Custom)
    // need a module for every purge target. These are the KNOWN unassigned
    // tables (gap R8); a NEW purge table without a module fails here.
    expect(unassigned).toEqual(KNOWN_UNASSIGNED_PURGE_TABLES);
    const modules = new Set([...PURGE_TABLES].map((table) => moduleOf(table)));
    for (const module of ["Orders", "Business masters", "Journals / Journal Lines", "Accounting Events"]) {
      expect(modules.has(module)).toBe(true);
    }
  });

  // R1-R8 status (Company Data Reset, Prompt 1). Executable evidence lives in
  // company-data-reset.{database,http.database,atomic.database}.test.ts and
  // company-data-reset.domains.test.ts; see
  // docs/architecture/company-data-reset-requirements.md section 3.
  it("R7 / R8: the planned reset maps EVERY purge table to exactly one reset domain (presets select by domain)", () => {
    expect(domainCoverageProblems()).toEqual([]);
  });
});

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

describe.skipIf(!runDatabase)("Company Data Reset requirements -- database (rolled back)", () => {
  async function inRolledBack<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    assertDisposableDatabase(process.env.DATABASE_URL);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      return await work(client);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  }

  async function company(client: pg.PoolClient) {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    const admin = randomUUID();
    const member = randomUUID();
    const adminRole = randomUUID();
    const memberRole = randomUUID();
    await client.query(
      "insert into companies (id,code,subdomain,name_en,status,environment,activated_at) " +
        "values ($1,$2,$3,'Reset requirements','active','development',now())",
      [id, `DEV-RRQ-${tag}`, `dev-rrq-${tag}`],
    );
    await client.query(
      "insert into accounts (id,company_id,account_kind,username,normalized_username,password_hash,status) " +
        "values ($1,$3,'company_user',$4,$4,'x','disabled'),($2,$3,'company_user',$5,$5,'x','disabled')",
      [admin, member, id, `rrq-admin-${tag}`, `rrq-member-${tag}`],
    );
    await client.query(
      "insert into company_users (company_id,account_id,name_en,display_name) values ($1,$2,'Admin','Admin'),($1,$3,'Member','Member')",
      [id, admin, member],
    );
    await client.query(
      "insert into roles (id,company_id,code,name,is_system,is_active) values " +
        "($1,$3,'company_admin','Admin',true,true),($2,$3,'rrq_member','Member',false,true)",
      [adminRole, memberRole, id],
    );
    await client.query(
      "insert into role_permissions (role_id,permission_code) values ($1,'users_roles.manage'),($2,'orders.create')",
      [adminRole, memberRole],
    );
    await client.query(
      "insert into account_roles (account_id,role_id,company_id) values ($1,$2,$5),($3,$4,$5)",
      [admin, adminRole, member, memberRole, id],
    );
    await client.query("insert into company_settings (company_id) values ($1)", [id]);
    return { admin, id, member };
  }

  it("Platform repair audit survives a full reset; the Company, its admin and its settings remain", async () => {
    await inRolledBack(async (client) => {
      const target = await company(client);
      const platformAdmin = randomUUID();
      await client.query(
        "insert into accounts (id,company_id,account_kind,username,normalized_username,password_hash,status) " +
          "values ($1,null,'platform_administrator',$2,$2,'x','disabled')",
        [platformAdmin, `rrq-platform-${platformAdmin.slice(0, 8)}`],
      );
      const entity = randomUUID();
      const execution = (
        await client.query<{ id: string }>(
          `insert into platform_repair_executions(company_id,order_id,entity_type,entity_id,entity_number,finding_id,
             reason_code,capability_code,preview_version,actor_account_id,actor_authority,reason,
             before_state_fingerprint,after_state_fingerprint,before_health,after_health,before_classification,
             after_classification,result,idempotency_key,request_hash)
           values ($1,$2,'order',$2,'ORD-RRQ','fnd_rrq','MISSING_RECEIVABLE','REPAIR_TRADER_RECEIVABLE','rcv1:x',$3,
             'platform.companies.repair_center.execute','Requirement test','a','b','ISSUE','HEALTHY',
             'MISSING_RECEIVABLE','HEALTHY_ACTIVE_RECEIVABLE','succeeded',$4,'h') returning id`,
          [target.id, entity, platformAdmin, `rrq-${randomUUID()}`],
        )
      ).rows[0]!.id;
      await client.query(
        `insert into platform_repair_attempts(company_id,entity_type,entity_id,actor_account_id,actor_authority,result,
           error_code,repair_execution_id)
         values ($1,'order',$2,$3,'platform.companies.repair_center.execute','REFUSED','repair_preview_stale',null),
                ($1,'order',$2,$3,'platform.companies.repair_center.execute','REPLAYED',null,$4)`,
        [target.id, entity, platformAdmin, execution],
      );

      const plan = await getResetCompanyUserPlan(client, target.id);
      expect([...plan.usersToRemove, ...plan.adminUsersPreserved].map((user) => user.accountId)).not.toContain(platformAdmin);

      await runReset(client, target.id, () => undefined);

      const counts = (
        await client.query<{ executions: number; attempts: number; company: number; admin: string | null; settings: number; platform: number }>(
          `select (select count(*)::int from platform_repair_executions where company_id = $1) as executions,
                  (select count(*)::int from platform_repair_attempts where company_id = $1) as attempts,
                  (select count(*)::int from companies where id = $1) as company,
                  (select status from accounts where id = $2) as admin,
                  (select count(*)::int from company_settings where company_id = $1) as settings,
                  (select count(*)::int from accounts where id = $3) as platform`,
          [target.id, target.admin, platformAdmin],
        )
      ).rows[0]!;
      expect(counts).toMatchObject({ attempts: 2, company: 1, executions: 1, platform: 1, settings: 1 });
      expect(counts.admin).not.toBeNull();
    });
  });

  it("Company A's reset never touches Company B's identities; identities are Company-scoped today", async () => {
    await inRolledBack(async (client) => {
      const a = await company(client);
      const b = await company(client);
      // Today's identity model: a Company account cannot be a member of
      // another Company (guard trigger), so an identity cannot be shared and
      // Company A's reset cannot remove access Company B relies on. If the
      // model ever becomes global, the user step's shared-identity checks
      // (company_users / account_roles / links / sessions / tokens in other
      // Companies) keep the identity and remove only Company A's access.
      await client.query("savepoint cross_company");
      await expect(
        client.query("insert into company_users (company_id,account_id,name_en,display_name) values ($1,$2,'X','X')", [
          b.id,
          a.member,
        ]),
      ).rejects.toThrow(/Company scope is invalid/u);
      await client.query("rollback to savepoint cross_company");
      const fingerprint = async () =>
        (
          await client.query<{ digest: string }>(
            `select md5(coalesce((select string_agg(t::text, '|' order by t::text) from accounts t where company_id = $1), '') ||
                        coalesce((select string_agg(t::text, '|' order by t::text) from company_users t where company_id = $1), '') ||
                        coalesce((select string_agg(t::text, '|' order by t::text) from account_roles t where company_id = $1), '')) as digest`,
            [b.id],
          )
        ).rows[0]!.digest;
      const before = await fingerprint();
      const plan = await getResetCompanyUserPlan(client, a.id);
      expect(plan.usersToRemove.every((user) => !user.sharedIdentity)).toBe(true);
      await runReset(client, a.id, () => undefined);
      expect(await fingerprint()).toBe(before);
      const left = (
        await client.query<{ member: number; admin: number }>(
          "select (select count(*)::int from accounts where id = $1) as member, (select count(*)::int from accounts where id = $2) as admin",
          [a.member, a.admin],
        )
      ).rows[0]!;
      // A's non-admin member is removed; A's protected admin stays.
      expect(left).toEqual({ admin: 1, member: 0 });
    });
  });
});
