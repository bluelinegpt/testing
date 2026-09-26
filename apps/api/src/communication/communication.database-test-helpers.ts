import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";

import type { ConfigService } from "@nestjs/config";

import { AuthenticationRepository } from "../authentication/authentication.repository.js";
import { AuthenticationService } from "../authentication/authentication.service.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";
import { PushOutboxWriter } from "../push/push-outbox-writer.service.js";
import { LocalFileStorageAdapter } from "../files/local-file-storage.adapter.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext } from "../security/identity-context.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { SessionTokenService } from "../authentication/session-token.service.js";
import { CommunicationService } from "./communication.service.js";

/** Guard for the approved, non-destructive local integration target. */
export async function assertGuardedCommunicationDatabase(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  const result = await sql<{ name: string }>`select current_database() as name`.execute(database);
  if (result.rows[0]?.name !== "blueline") {
    throw new Error("Communication database tests require the guarded blueline database");
  }
}

/** Every fixture is labelled so committed cleanup can only target this run. */
export function communicationTestRunId(): string {
  return `comm-test-${randomUUID()}`;
}

/**
 * Runs fixture work in one transaction and always rolls it back. No existing
 * development rows are reset, truncated, or used as test data.
 */
export async function withRolledBackCommunicationFixtures<T>(
  database: Kysely<DatabaseSchema>,
  work: (transaction: Transaction<DatabaseSchema>, runId: string) => Promise<T>,
): Promise<T> {
  const rollback = Symbol("communication fixture rollback");
  let result: T | undefined;
  try {
    await database.transaction().execute(async (transaction) => {
      result = await work(transaction, communicationTestRunId());
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result as T;
}

/**
 * Narrowly deletes only rows created by a given synthetic run id, in FK-safe
 * order. Used only when a scenario genuinely needs committed rows (for
 * example, proving the narrow-cleanup mechanism itself) — never a
 * truncate/reset of any table.
 *
 * HARD LIMITATION — read before calling this with a realistic fixture:
 * `customers`/`customer_addresses` (`reject_customer_delete`), `roles`
 * (`roles_no_delete`, unconditional — every Role, for every kind of
 * account), and `company_user` `accounts` (`reject_administration_delete`)
 * are ALL permanently undeletable by design once committed. Because any
 * permissioned account (office, Trader, or Driver) requires an assigned
 * Role, this means **no realistic communication fixture with any account
 * can ever be fully, narrowly cleaned up after a real commit** — the schema
 * itself has no path back. This function refuses to run against a run id
 * that created a Customer or a Role, so that mistake fails loudly here
 * instead of leaving permanent, silent residue in the guarded database (as
 * it once did during this suite's own development — see the Prompt 12A
 * report). Every scenario that touches an account, a Role, or a Customer
 * MUST run inside `withRolledBackCommunicationFixtures` instead; this
 * function exists only for narrow, account-free committed fixtures (for
 * example, proving the cleanup mechanism against bare `companies` rows).
 */
export async function cleanupCommunicationRunId(
  database: Kysely<DatabaseSchema>,
  runId: string,
): Promise<void> {
  const companyIds = await sql<{ id: string }>`
    select id from companies where code like ${`${runId}%`}
  `.execute(database);
  const ids = companyIds.rows.map((row) => row.id);
  if (ids.length === 0) return;

  const customerCount = await sql<{ count: string }>`
    select count(*)::text as count from customers where company_id = any(${ids}::uuid[])
  `.execute(database);
  if (customerCount.rows[0]?.count !== "0") {
    throw new Error(
      "cleanupCommunicationRunId cannot remove Customer rows (reject_customer_delete is permanent) — " +
        "a committed fixture must never create a Customer. Use a rolled-back transaction for any " +
        "Customer-messaging scenario instead.",
    );
  }
  const roleCount = await sql<{ count: string }>`
    select count(*)::text as count from roles where company_id = any(${ids}::uuid[])
  `.execute(database);
  if (roleCount.rows[0]?.count !== "0") {
    throw new Error(
      "cleanupCommunicationRunId cannot remove Role rows (roles_no_delete is permanent, and " +
        "unconditional — it blocks every Role delete regardless of account kind) — a committed " +
        "fixture must never create a Role/permissioned account. Use a rolled-back transaction for " +
        "any scenario involving an office, Trader, or Driver account instead.",
    );
  }

  // The whole cleanup runs in one transaction so the deferred
  // "an active User must have at least one active Role" constraint trigger
  // (`accounts_active_role_guard` / `account_roles_active_user_guard`, both
  // `deferrable initially deferred`) only evaluates once at the final
  // COMMIT — by which point the account rows themselves are also gone, so
  // there is no orphaned "active account, zero roles" state left to flag.
  await database.transaction().execute(async (transaction) => {
    for (const companyId of ids) {
      await sql`delete from communication_notification_outbox where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from realtime_event_log where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      // conversation_participants and realtime_event_log both reference
      // customer_messaging_sessions (restrict), which itself references
      // messages/conversations/orders/customers/tracking_tokens (also
      // restrict) — so participants must go before sessions, and sessions
      // before every row they point at.
      await sql`delete from conversation_participants where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from customer_messaging_sessions where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      // `conversations_last_message_fk` is a composite FK on
      // (last_message_id, company_id); Postgres's ON DELETE SET NULL for a
      // composite FK nulls *every* referencing column, including company_id
      // — which is NOT NULL. Detach it explicitly first so deleting
      // messages never triggers that automatic action.
      await sql`update conversations set last_message_id = null where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from messages where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from conversations where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from tracking_tokens where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from orders where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from user_business_links where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from areas where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from drivers where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from traders where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from account_roles where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from role_permissions where role_id in (select id from roles where company_id = ${companyId}::uuid)`.execute(
        transaction,
      );
      await sql`delete from roles where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from company_users where company_id = ${companyId}::uuid`.execute(
        transaction,
      );
      await sql`delete from accounts where company_id = ${companyId}::uuid`.execute(transaction);
      await sql`delete from companies where id = ${companyId}::uuid`.execute(transaction);
    }
  });
}

function sanitizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Companies' subdomain check constraint forbids underscores; hyphens only. */
function sanitizeSubdomain(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface FixtureCompany {
  readonly companyId: string;
  readonly subdomain: string;
  readonly code: string;
}

/** A Company row, labelled with the run id so cleanup can find it narrowly. */
export async function createFixtureCompany(
  transaction: Transaction<DatabaseSchema>,
  runId: string,
  label: string,
): Promise<FixtureCompany> {
  const companyId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const code = `${runId}-${sanitizeLabel(label)}-${suffix}`.slice(0, 60);
  const subdomain = `c-${sanitizeSubdomain(label)}-${suffix}`.slice(0, 60);
  // `companies.environment` defaults to `production` at the schema level —
  // every fixture builder must override it explicitly, or a leaked/committed
  // row inherits Production's 48-hour deletion wait for no reason connected
  // to what it actually is.
  await sql`
    insert into companies (id, code, subdomain, name_en, status, environment, activated_at)
    values (${companyId}::uuid, ${code}, ${subdomain}, ${`Communication Co ${label}`}, 'active', 'development', now())
  `.execute(transaction);
  return { code, companyId, subdomain };
}

export interface FixtureAccount {
  readonly accountId: string;
  readonly username: string;
  readonly password: string;
}

async function insertRoleWithPermissions(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  accountId: string,
  label: string,
  permissions: readonly string[],
): Promise<void> {
  const roleId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const code = `comm_${sanitizeLabel(label)}_${suffix}`;
  await sql`
    insert into roles (id, company_id, code, name, is_system, is_active)
    values (${roleId}::uuid, ${companyId}::uuid, ${code}, ${`Role ${label} ${suffix}`}, true, true)
  `.execute(transaction);
  if (permissions.length > 0) {
    await sql`
      insert into role_permissions (role_id, permission_code)
      values ${sql.join(permissions.map((permission) => sql`(${roleId}::uuid, ${permission})`))}
    `.execute(transaction);
  }
  await sql`
    insert into account_roles (account_id, role_id, company_id)
    values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
  `.execute(transaction);
}

/** A Company-user (office) account with the given permission set. */
export async function createFixtureOfficeUser(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  label: string,
  permissions: readonly string[],
): Promise<FixtureAccount> {
  const accountId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const username = `office-${sanitizeLabel(label)}-${suffix}`;
  const password = `Comm-Test-${suffix}-Aa1!`;
  const hasher = new PasswordHasher();
  const hash = await hasher.hash(password);
  await sql`
    insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
    values (${accountId}::uuid, ${companyId}::uuid, 'company_user', ${username}, ${hash}, 'active', now())
  `.execute(transaction);
  await sql`
    insert into company_users (company_id, account_id, display_name, name_en)
    values (${companyId}::uuid, ${accountId}::uuid, ${`Office ${label}`}, ${`Office ${label}`})
  `.execute(transaction);
  await insertRoleWithPermissions(transaction, companyId, accountId, label, permissions);
  return { accountId, password, username };
}

export interface FixtureTrader extends FixtureAccount {
  readonly traderId: string;
}

/** A Trader account, profile, and business-link so login can resolve a profileId. */
export async function createFixtureTrader(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  label: string,
  permissions: readonly string[],
): Promise<FixtureTrader> {
  const accountId = randomUUID();
  const traderId = randomUUID();
  const linkId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const username = `trader-${sanitizeLabel(label)}-${suffix}`;
  const password = `Comm-Test-${suffix}-Bb1!`;
  const hasher = new PasswordHasher();
  const hash = await hasher.hash(password);
  await sql`
    insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
    values (${accountId}::uuid, ${companyId}::uuid, 'trader', ${username}, ${hash}, 'active', now())
  `.execute(transaction);
  await sql`
    insert into traders (id, company_id, account_id, code, name_en, mobile_number, account_status)
    values (${traderId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`TR-${suffix}`}, ${`Trader ${label}`}, '971500000001', 'active')
  `.execute(transaction);
  await sql`
    insert into user_business_links (id, company_id, account_id, entity_type, entity_id, access_status, is_primary, created_by_account_id)
    values (${linkId}::uuid, ${companyId}::uuid, ${accountId}::uuid, 'trader', ${traderId}::uuid, 'active', true, ${accountId}::uuid)
  `.execute(transaction);
  await insertRoleWithPermissions(transaction, companyId, accountId, label, permissions);
  return { accountId, password, traderId, username };
}

export interface FixtureDriver extends FixtureAccount {
  readonly driverId: string;
}

/** A Driver account, profile, and business-link so login can resolve a profileId. */
export async function createFixtureDriver(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  label: string,
  permissions: readonly string[],
): Promise<FixtureDriver> {
  const accountId = randomUUID();
  const driverId = randomUUID();
  const linkId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const username = `driver-${sanitizeLabel(label)}-${suffix}`;
  const password = `Comm-Test-${suffix}-Cc1!`;
  const hasher = new PasswordHasher();
  const hash = await hasher.hash(password);
  await sql`
    insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
    values (${accountId}::uuid, ${companyId}::uuid, 'driver', ${username}, ${hash}, 'active', now())
  `.execute(transaction);
  await sql`
    insert into drivers (
      id, company_id, account_id, code, driver_type, name_en, mobile_number,
      account_status, outsourced_fee_per_delivered_order
    ) values (
      ${driverId}::uuid, ${companyId}::uuid, ${accountId}::uuid, ${`DR-${suffix}`}, 'outsourced',
      ${`Driver ${label}`}, '971500000002', 'active', 7.5
    )
  `.execute(transaction);
  await sql`
    insert into user_business_links (id, company_id, account_id, entity_type, entity_id, access_status, is_primary, created_by_account_id)
    values (${linkId}::uuid, ${companyId}::uuid, ${accountId}::uuid, 'driver', ${driverId}::uuid, 'active', true, ${accountId}::uuid)
  `.execute(transaction);
  await insertRoleWithPermissions(transaction, companyId, accountId, label, permissions);
  return { accountId, driverId, password, username };
}

export interface FixtureCustomer {
  readonly customerId: string;
}

/** A Customer row, `active` unless the test asks for `disabled`. */
export async function createFixtureCustomer(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  createdByAccountId: string,
  label: string,
  status: "active" | "disabled" = "active",
): Promise<FixtureCustomer> {
  const customerId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await sql`
    insert into customers (id, company_id, code, name, mobile_number, status, created_by_account_id)
    values (${customerId}::uuid, ${companyId}::uuid, ${`CU-${suffix}`}, ${`Customer ${label}`}, '971500000003', ${status}, ${createdByAccountId}::uuid)
  `.execute(transaction);
  return { customerId };
}

export interface FixtureOrder {
  readonly orderId: string;
  readonly orderNumber: string;
}

/** A minimal, valid Order that can anchor Trader/Driver/Customer conversations. */
export async function createFixtureOrder(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  createdByAccountId: string,
  options: {
    readonly traderId: string;
    readonly driverId?: string | null;
    readonly customerId?: string | null;
  },
): Promise<FixtureOrder> {
  const orderId = randomUUID();
  const areaId = randomUUID();
  const suffix = orderId.slice(0, 8);
  const orderNumber = `ORD-${suffix}`;
  const areaCode = `A-${suffix}`;
  const areaName = `Area ${suffix}`;
  await sql`
    insert into areas (id, company_id, emirate_id, code, name_en)
    values (${areaId}::uuid, ${companyId}::uuid, (select id from emirates where code = 'DXB'), ${areaCode}, ${areaName})
  `.execute(transaction);

  // A resolved Customer link requires a full snapshot (`orders_customer_provenance_check`):
  // a saved address plus non-empty code/area snapshots. An order with no
  // Customer stays `legacy_unattributed` with every snapshot column null.
  let customerAddressId: string | null = null;
  let customerCodeSnapshot: string | null = null;
  const provenanceStatus = options.customerId == null ? "legacy_unattributed" : "resolved";
  if (options.customerId != null) {
    customerAddressId = randomUUID();
    customerCodeSnapshot = `CU-${suffix}`;
    // A Customer must have exactly one active default address (a deferred
    // trigger only checked at commit — invisible to every rolled-back test,
    // but real for any scenario that actually commits). A second Order for
    // the same Customer must reuse that invariant, not fight it.
    const hasDefault = await sql<{ exists: boolean }>`
      select exists (
        select 1 from customer_addresses
         where company_id = ${companyId}::uuid and customer_id = ${options.customerId}::uuid
           and is_active and is_default
      ) as exists
    `.execute(transaction);
    const isDefault = hasDefault.rows[0]?.exists !== true;
    await sql`
      insert into customer_addresses (id, company_id, customer_id, area_id, address, created_by_account_id, is_default)
      values (${customerAddressId}::uuid, ${companyId}::uuid, ${options.customerId}::uuid, ${areaId}::uuid, 'Fixture Address', ${createdByAccountId}::uuid, ${isDefault})
    `.execute(transaction);
  }

  await sql`
    insert into orders (
      service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
      created_by_account_id, assigned_driver_id, customer_id, customer_name,
      customer_mobile_number, customer_address, package_count, payment_condition,
      amount_collected, customer_amount_due, driver_cost,
      trader_gross_payable, trader_paid_service_fee, trader_deductions,
      trader_charges, trader_adjustments, trader_net_payable,
      delivery_status, driver_reconciliation_status, trader_settlement_status,
      delivered_at, pricing_provenance_status, final_service_fee_snapshot,
      customer_provenance_status, customer_address_id, customer_code_snapshot,
      customer_area_code_snapshot, customer_area_name_snapshot
    ) values (
      'Zero configured Service Fee (fixture)', ${orderId}::uuid, ${companyId}::uuid, ${orderNumber}, current_date,
      ${options.traderId}::uuid, ${areaId}::uuid, ${createdByAccountId}::uuid, ${options.driverId ?? null},
      ${options.customerId ?? null}, 'Fixture Customer', '971500000004', 'Fixture Address', 1,
      'customer_pays_cod_and_fee', 0, 55, 7.5, 55, 0, 0, 0, 0, 55,
      'assigned_to_driver', 'not_applicable', 'not_eligible', null, 'legacy_unattributed', 0,
      ${provenanceStatus}, ${customerAddressId}, ${customerCodeSnapshot},
      ${options.customerId == null ? null : areaCode}, ${options.customerId == null ? null : areaName}
    )
  `.execute(transaction);
  return { orderId, orderNumber };
}

export interface FixtureTrackingToken {
  readonly rawToken: string;
  readonly trackingTokenId: string;
}

/** A tracking token, valid unless `revoked`/`expired` is requested. */
export async function createFixtureTrackingToken(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  orderId: string,
  options: { readonly revoked?: boolean; readonly expired?: boolean } = {},
): Promise<FixtureTrackingToken> {
  const trackingTokenId = randomUUID();
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  // The expiry check constraint requires expires_at > created_at, so an
  // "already expired" fixture must backdate created_at too — it cannot just
  // set expires_at to a past `now()`, which would violate the constraint.
  const createdAt = options.expired === true ? sql`now() - interval '2 hours'` : sql`now()`;
  const expiresAt =
    options.expired === true ? sql`now() - interval '1 hour'` : sql`now() + interval '1 day'`;
  await sql`
    insert into tracking_tokens (id, company_id, order_id, token_hash, expires_at, revoked_at, created_at)
    values (
      ${trackingTokenId}::uuid, ${companyId}::uuid, ${orderId}::uuid, ${tokenHash},
      ${expiresAt}, ${options.revoked === true ? sql`now()` : null}, ${createdAt}
    )
  `.execute(transaction);
  return { rawToken, trackingTokenId };
}

/**
 * A settable identity accessor for direct CommunicationService calls in
 * tests. Production code resolves this from the authenticated request; tests
 * drive it explicitly since each `it` runs single-threaded and sequentially.
 */
export class StaticIdentityAccessor extends IdentityContextAccessor {
  public identity: IdentityContext | undefined;

  public override current(): IdentityContext {
    if (this.identity === undefined) throw new Error("No identity set for this test step");
    return this.identity;
  }
}

/** A dedicated root, separate from the real DEV `.file-storage` directory, so
 *  voice-message bytes written by a test never intermix with real local data
 *  — matches this suite's existing "never touch real data" discipline, just
 *  applied to the filesystem instead of the database. */
const TEST_FILE_STORAGE_ROOT = resolve(process.cwd(), ".file-storage-test");

function testStorageConfig(): ConfigService<AppConfiguration, true> {
  return {
    get: (key: string) =>
      key === "files.provider"
        ? "local"
        : key === "files.localRoot"
          ? TEST_FILE_STORAGE_ROOT
          : undefined,
  } as unknown as ConfigService<AppConfiguration, true>;
}

/** Builds a CommunicationService bound to the test transaction. Voice-message
 *  storage uses a real `LocalFileStorageAdapter` (not a mock) — media
 *  upload/download authorization is a real requirement here, not a UI
 *  affordance, so the tests that exercise it read real bytes back.
 *
 *  `transactions.execute` runs the work directly against the already-active
 *  test transaction rather than opening a real nested one — Kysely does not
 *  support calling `.transaction()` again on a `Transaction` instance, and
 *  the outer `withRolledBackCommunicationFixtures` transaction already gives
 *  every write in one `it()` the atomicity (and guaranteed rollback) a real
 *  nested transaction would. Same stub shape as
 *  `company-profile.database.test.ts` uses for the identical reason. */
export function createTestCommunicationService(
  transaction: Transaction<DatabaseSchema>,
  accessor: StaticIdentityAccessor,
): CommunicationService {
  const database = transaction as unknown as Kysely<DatabaseSchema>;
  const transactions = {
    execute: <T>(work: (t: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> =>
      work(transaction),
  } as unknown as KyselyTransactionManager;
  return new CommunicationService(
    database,
    accessor,
    transactions,
    new LocalFileStorageAdapter(testStorageConfig()),
    new FileOwnershipService(database),
    new PushOutboxWriter(),
    testStorageConfig(),
  );
}

/** A real AuthenticationService bound to the test transaction, for real login/authenticate flows. */
export function createTestAuthenticationService(
  transaction: Transaction<DatabaseSchema>,
): AuthenticationService {
  const repository = new AuthenticationRepository(transaction as unknown as Kysely<DatabaseSchema>);
  const config = {
    get: (key: string) => (key === "auth.lockoutMinutes" ? 15 : 720),
  } as unknown as ConfigService<AppConfiguration, true>;
  return new AuthenticationService(
    repository,
    new PasswordHasher(),
    new SessionTokenService(),
    config,
  );
}
