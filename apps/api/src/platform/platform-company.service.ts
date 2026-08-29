import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { AccountingTemplateImporter } from "../accounting-template/accounting-template.importer.js";
import {
  TemplateNotApprovedError,
  latestTemplateVersion,
  listApprovedTemplates,
} from "../accounting-template/accounting-template.registry.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { isReservedCompanySubdomain } from "../tenancy/reserved-subdomains.js";
import { PlatformAuditService, redactSensitive } from "./platform-audit.service.js";
import { STANDARD_COMPANY_ROLES } from "./standard-company-roles.js";

/**
 * Company lifecycle and onboarding for the Platform Portal.
 *
 * ---------------------------------------------------------------------------
 * CREATION IS ONE TRANSACTION OR IT IS NOTHING
 * ---------------------------------------------------------------------------
 *
 * The Company row, its settings, its entire Accounting setup and the audit
 * record are written inside a single transaction. There is no compensating
 * cleanup path and no "mark it failed and move on" branch, because a
 * half-configured tenant is worse than no tenant: it looks real, it appears in
 * the list, and the first thing anyone does with it produces a posting error
 * nobody can explain.
 *
 * The importer never owns the transaction, so a failure anywhere inside it —
 * a missing account key, a mapping that will not resolve, a verification that
 * does not add up — takes the Company row with it.
 *
 * ---------------------------------------------------------------------------
 * A NEW COMPANY IS NEVER BORN ACTIVE
 * ---------------------------------------------------------------------------
 *
 * Creation always produces `draft`. Activation is a separate, explicit,
 * server-checked action, and in this phase it stays unavailable until the first
 * Company Administrator exists — which Prompt 4 builds. Activating a tenant
 * nobody can sign in to would make "Active" mean something it does not.
 */

export type CompanyEnvironment = "development" | "demo" | "sandbox" | "trial" | "production";
export type CompanyStatus = "draft" | "active" | "suspended" | "disabled" | "closed";

/**
 * Legal lifecycle transitions.
 *
 * Expressed as data so the rule is one table rather than a chain of `if`s
 * spread across three action handlers, and so an illegal transition is
 * impossible to reach rather than merely unlikely.
 */
const legalTransitions: Readonly<Record<CompanyStatus, readonly CompanyStatus[]>> = {
  draft: ["active", "closed"],
  active: ["suspended", "closed"],
  suspended: ["active", "closed"],
  // Terminal. Reopening a closed Company is a decision nobody has made yet, and
  // guessing it here would be inventing product.
  disabled: [],
  closed: [],
};

export interface CompanyListQuery {
  readonly search?: string | undefined;
  readonly status?: CompanyStatus | undefined;
  readonly environment?: CompanyEnvironment | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sort?: string | undefined;
  readonly direction?: "asc" | "desc" | undefined;
}

export interface CompanyListRow {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly subdomain: string;
  readonly status: CompanyStatus;
  readonly environment: CompanyEnvironment;
  readonly countryCode: string;
  readonly timezone: string | null;
  readonly baseCurrency: string | null;
  readonly defaultLanguage: string | null;
  readonly accountingSetupStatus: string;
  readonly companyAdminCount: number;
  /**
   * Overall onboarding state, derived in SQL rather than by calling the full
   * readiness rule per row. The list would otherwise issue one readiness
   * computation per Company, which is the classic N+1 that only hurts once the
   * product has customers.
   */
  readonly readinessState: string;
  readonly createdAt: Date;
}

export interface CreateCompanyInput {
  readonly name: string;
  readonly shipmentPrefix: string;
  readonly subdomain?: string | undefined;
  readonly environment: CompanyEnvironment;
  readonly countryCode: string;
  readonly timezone: string;
  readonly defaultLanguage: "en" | "ar";
  readonly contactName?: string | undefined;
  readonly telephone?: string | undefined;
  readonly email?: string | undefined;
  readonly businessDayStart?: string | undefined;
  readonly accountingTemplateCode?: string | undefined;
  readonly accountingTemplateVersion?: number | undefined;
}

const sortColumns: Readonly<Record<string, string>> = {
  code: "c.code",
  name: "c.name_en",
  status: "c.status",
  environment: "c.environment",
  createdAt: "c.created_at",
};

/** IANA zones the product supports today. Validated server-side, never trusted. */
const supportedTimezones = new Set(["Asia/Dubai"]);

/** ASCII-only by design: Arabic-only names require an explicit safe override. */
export function suggestCompanySubdomain(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "");
}

@Injectable()
export class PlatformCompanyService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    // Transactions go through the shared manager rather than
    // `database.transaction()` directly. That is this repository's established
    // seam: a database-backed test overrides the manager so the service's work
    // joins the test's own rolled-back transaction instead of opening a second
    // connection the test could never undo.
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingTemplateImporter) private readonly importer: AccountingTemplateImporter,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  public templates(): ReturnType<typeof listApprovedTemplates> {
    return listApprovedTemplates();
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  public async list(
    query: CompanyListQuery,
  ): Promise<{ items: readonly CompanyListRow[]; total: number; page: number; pageSize: number }> {
    const search = query.search?.trim() ?? "";
    const column = sortColumns[query.sort ?? "code"] ?? "c.code";
    const direction = query.direction === "desc" ? sql`desc` : sql`asc`;
    const filters = sql`
      where (${search} = '' or c.name_en ilike ${`%${search}%`} or c.code ilike ${`%${search}%`}
             or c.subdomain ilike ${`%${search}%`})
        and (${query.status ?? null}::text is null or c.status = ${query.status ?? null})
        and (${query.environment ?? null}::text is null or c.environment = ${query.environment ?? null})
    `;

    const total = Number(
      (
        await sql<{ n: string }>`select count(*)::bigint n from companies c ${filters}`.execute(
          this.database,
        )
      ).rows[0]?.n ?? 0,
    );

    const items = (
      await sql<CompanyListRow>`
        select c.id, c.code, c.name_en as "nameEn", c.subdomain, c.status, c.environment,
               c.country_code as "countryCode", c.accounting_setup_status as "accountingSetupStatus",
               c.created_at as "createdAt",
               s.timezone, s.base_currency as "baseCurrency", s.default_language as "defaultLanguage",
               (select count(*)::int from company_users u
                 join accounts a on a.id = u.account_id
                where u.company_id = c.id and u.is_active = true and a.status = 'active'
               ) as "companyAdminCount",
               case
                 when c.status = 'disabled' then 'closed'
                 when c.status = 'suspended' then 'suspended'
                 when c.status = 'active' then 'live'
                 when c.accounting_setup_status = 'ready'
                   and exists (select 1 from company_users u
                                join accounts a on a.id = u.account_id
                               where u.company_id = c.id and u.is_active = true
                                 and a.status = 'active')
                   then 'ready_to_activate'
                 else 'incomplete'
               end as "readinessState"
          from companies c
          left join company_settings s on s.company_id = c.id
          ${filters}
         order by ${sql.raw(column)} ${direction}, c.code asc
         limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `.execute(this.database)
    ).rows;

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  public async details(companyId: string): Promise<Record<string, unknown>> {
    const company = (
      await sql<Record<string, unknown>>`
        select c.id, c.code, c.name_en as "nameEn", c.name_ar as "nameAr", c.subdomain,
               c.mobile_code as "mobileCode", c.version,
               c.shipment_prefix as "shipmentPrefix",
               c.shipment_serial_enabled_at as "shipmentSerialEnabledAt",
               c.status, c.environment, c.country_code as "countryCode",
               c.contact_name as "contactName", c.telephone, c.email, c.address_en as "addressEn",
               c.trade_license_number as "tradeLicenseNumber",
               c.tax_registration_number as "taxRegistrationNumber",
               c.created_at as "createdAt", c.activated_at as "activatedAt",
               c.suspended_at as "suspendedAt", c.disabled_at as "disabledAt", c.closed_at as "closedAt",
               c.status_changed_at as "statusChangedAt", c.status_change_reason as "statusChangeReason",
               c.accounting_setup_status as "accountingSetupStatus",
               c.accounting_template_code as "accountingTemplateCode",
               c.accounting_template_version as "accountingTemplateVersion",
               c.accounting_template_sha256 as "accountingTemplateSha256",
               c.accounting_setup_applied_at as "accountingSetupAppliedAt",
               (select a.username from accounts a where a.id = c.accounting_setup_applied_by_account_id)
                 as "accountingSetupAppliedBy",
               s.timezone, s.base_currency as "baseCurrency", s.default_language as "defaultLanguage",
               s.vat_enabled as "vatEnabled"
          from companies c
          left join company_settings s on s.company_id = c.id
         where c.id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (company === undefined) throw this.notFound();
    return company;
  }

  /** Read-only summary of what the template actually created. */
  public async accountingSetup(companyId: string): Promise<Record<string, unknown>> {
    // The zero-history counts are included alongside the setup counts on
    // purpose: the Accounting Setup panel is the one place someone looks to
    // confirm a new tenant really did start empty.
    const resolved = (
      await sql<Record<string, string>>`
        select (select count(*)::bigint from chart_of_accounts where company_id = ${companyId}::uuid) as "accounts",
               (select count(*)::bigint from account_mappings where company_id = ${companyId}::uuid) as "mappings",
               (select count(*)::bigint from expense_types where company_id = ${companyId}::uuid) as "expenseTypes",
               (select count(*)::bigint from general_expense_categories where company_id = ${companyId}::uuid) as "categories",
               (select count(*)::bigint from allowance_types where company_id = ${companyId}::uuid) as "allowanceTypes",
               (select count(*)::bigint from company_reference_counters where company_id = ${companyId}::uuid) as "referencePrefixes",
               (select count(*)::bigint from company_cash_accounts where company_id = ${companyId}::uuid) as "cashAccounts",
               (select count(*)::bigint from company_bank_accounts where company_id = ${companyId}::uuid) as "bankAccounts",
               (select count(*)::bigint from opening_balance_batches where company_id = ${companyId}::uuid) as "openingBalanceBatches",
               (select count(*)::bigint from journal_entries where company_id = ${companyId}::uuid) as "journals",
               (select count(*)::bigint from accounting_events where company_id = ${companyId}::uuid) as "accountingEvents"
      `.execute(this.database)
    ).rows[0];

    const company = await this.details(companyId);
    const businessDay = (
      await sql<{ timezone: string; start: string }>`
        select timezone, business_day_start::text as start
          from company_business_day_configurations
         where company_id = ${companyId}::uuid and is_active = true and effective_to is null
         order by effective_from desc nulls last limit 1
      `.execute(this.database)
    ).rows[0];

    return {
      status: company.accountingSetupStatus,
      templateCode: company.accountingTemplateCode,
      templateVersion: company.accountingTemplateVersion,
      templateSha256: company.accountingTemplateSha256,
      appliedAt: company.accountingSetupAppliedAt,
      appliedBy: company.accountingSetupAppliedBy,
      businessDay:
        businessDay === undefined
          ? null
          : { timezone: businessDay.timezone, startTime: businessDay.start.slice(0, 5) },
      counts: Object.fromEntries(
        Object.entries(resolved ?? {}).map(([key, value]) => [key, Number(value)]),
      ),
    };
  }

  /**
   * Server-derived readiness.
   *
   * Computed here and never in the browser: readiness decides whether
   * activation is offered, and a rule the client could reinterpret is not a
   * rule. Each item carries its own state, and only items marked `required`
   * block activation — an optional gap is reported, not treated as a failure.
   */
  public async readiness(companyId: string): Promise<Record<string, unknown>> {
    const company = await this.details(companyId);
    const settings = {
      timezone: company.timezone as string | null,
      currency: company.baseCurrency as string | null,
      language: company.defaultLanguage as string | null,
    };
    /**
     * A Company Administrator counts only when they can actually SIGN IN.
     *
     * An inserted row is not readiness: an account that has never set a
     * password cannot log in, so a Company activated on the strength of one
     * would be "Active" with nobody able to enter it. The conditions are
     * therefore an active account, an active Company-user profile, an active
     * Company Administrator role, and a password the person has established
     * themselves (`force_password_change` cleared and `password_changed_at`
     * set by the account-setup flow).
     */
    const credentialReadyAdmins = Number(
      (
        await sql<{ n: string }>`
          select count(*)::bigint n
            from company_users u
            join accounts a on a.id = u.account_id
           where u.company_id = ${companyId}::uuid
             and u.is_active = true
             and a.status = 'active'
             and a.force_password_change = false
             and a.password_changed_at is not null
             and exists (
               select 1 from account_roles ar
                 join roles r on r.id = ar.role_id
                where ar.account_id = a.id
                  and r.company_id = ${companyId}::uuid
                  and r.is_active = true
                  and lower(r.code) = 'company_admin'
             )
        `.execute(this.database)
      ).rows[0]?.n ?? 0,
    );
    // Counted separately so the UI can distinguish "nobody invited yet" from
    // "invited, waiting for them to set a password".
    const invitedAdmins = Number(
      (
        await sql<{ n: string }>`
          select count(*)::bigint n from company_users u
            join accounts a on a.id = u.account_id
           where u.company_id = ${companyId}::uuid and u.is_active = true and a.status = 'active'
        `.execute(this.database)
      ).rows[0]?.n ?? 0,
    );
    const admins = credentialReadyAdmins;
    const bank = (
      await sql<{ iban: string | null; number: string | null }>`
        select iban, account_number as number from company_bank_accounts
         where company_id = ${companyId}::uuid and is_active = true limit 1
      `.execute(this.database)
    ).rows[0];
    const openingBalances = Number(
      (
        await sql<{ n: string }>`
          select count(*)::bigint n from opening_balance_batches where company_id = ${companyId}::uuid
        `.execute(this.database)
      ).rows[0]?.n ?? 0,
    );

    const items = [
      item("companyProfile", "Company profile", true, String(company.nameEn ?? "").trim() !== ""),
      item("companyCode", "Company code", true, String(company.code ?? "").trim() !== ""),
      item("environment", "Environment", true, company.environment !== null),
      item("subdomain", "Subdomain", true, String(company.subdomain ?? "").trim() !== ""),
      item("timezone", "Timezone", true, settings.timezone !== null),
      item("currency", "Currency", true, settings.currency !== null),
      item("language", "Default language", true, settings.language !== null),
      item("accountingSetup", "Accounting setup", true, company.accountingSetupStatus === "ready"),
      item(
        "companyAdmin",
        "Company Administrator",
        true,
        admins > 0,
        admins === 0 ? "Pending" : undefined,
      ),
      // Bank identity is a required company input before the bank is USED, not
      // before the tenant exists. Reported, never blocking.
      item(
        "bankDetails",
        "Bank details",
        false,
        bank !== undefined && (bank.iban !== null || bank.number !== null),
        "Placeholder created; enter the Company bank details",
      ),
      // A new Company may legitimately begin with no history at all.
      item("openingBalance", "Opening balance", false, openingBalances > 0, "Not entered"),
    ];

    /**
     * Accounting periods are created `future` by onboarding (Prompt 3). That is
     * deliberate, and it is NOT an onboarding failure - but it does mean
     * financial posting is unavailable until someone opens one, which an
     * administrator should be told rather than discover.
     *
     * Reported as a warning, never as a blocked readiness item, and nothing
     * here opens a period.
     */
    const openPeriods = Number(
      (
        await sql<{ n: string }>`
          select count(*)::bigint n from accounting_periods
           where company_id = ${companyId}::uuid and status in ('open', 'reopened')
        `.execute(this.database)
      ).rows[0]?.n ?? 0,
    );
    const warnings =
      openPeriods === 0 && company.accountingSetupStatus === "ready"
        ? ["Accounting period not yet open - financial posting remains unavailable."]
        : [];

    const blocking = items.filter((entry) => entry.required && entry.state !== "complete");
    return {
      status: company.status,
      items,
      warnings,
      canActivate: company.status === "draft" && blocking.length === 0,
      blockedBy: blocking.map((entry) => entry.key),
      nextStep:
        invitedAdmins === 0
          ? "Create Company Administrator"
          : credentialReadyAdmins === 0
            ? "Waiting for the administrator to set a password"
            : "Activate Company",
    };
  }

  /**
   * Recent Platform audit for one Company.
   *
   * Read from the existing append-only `audit_events` table — there is no
   * second trail. Capped and ordered newest-first: this is a summary panel on a
   * detail page, not a log browser, and an unbounded read of a busy Company's
   * history would be a very effective way to make the page unusable.
   *
   * `before_data` / `after_data` are returned as stored. Nothing sensitive
   * reaches them: the writers record field-level changes and lifecycle values,
   * never credentials.
   */
  public async auditSummary(
    companyId: string,
    limit = 25,
  ): Promise<readonly Record<string, unknown>[]> {
    return (
      await sql<Record<string, unknown>>`
        select e.action,
               e.reason,
               e.before_data as "before",
               e.after_data as "after",
               e.occurred_at as "occurredAt",
               e.correlation_id as "correlationId",
               e.source,
               (select a.username from accounts a where a.id = e.actor_account_id) as actor
          from audit_events e
         where e.company_id = ${companyId}::uuid
           and e.action like 'platform.%'
         order by e.occurred_at desc
         limit ${Math.min(Math.max(limit, 1), 100)}
      `.execute(this.database)
    ).rows;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  public async create(
    input: CreateCompanyInput,
    actor: {
      accountId: string;
      correlationId: string;
      ip?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<{ companyId: string; accountingSetup: Record<string, unknown> | null }> {
    if (!supportedTimezones.has(input.timezone)) {
      throw new ApplicationException(
        "timezone_not_supported",
        `Timezone '${input.timezone}' is not supported`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const applyTemplate = input.accountingTemplateCode !== undefined;

    try {
      return await this.transactions.execute(async (transaction) => {
        const codeNumber = (
          await sql<{
            value: string;
          }>`select nextval('platform_company_code_seq')::text as value`.execute(transaction)
        ).rows[0]?.value;
        if (codeNumber === undefined) throw new Error("Company code generation failed");
        const code = `CMP-${codeNumber.padStart(6, "0")}`;
        const subdomain = await this.resolveSubdomain(transaction, input.name, input.subdomain);
        const companyId = (
          await sql<{ id: string }>`
            insert into companies (
              code, subdomain, name_en, contact_name, telephone, email, status, environment,
              country_code, shipment_prefix, status_changed_at, status_changed_by_account_id
            ) values (
              ${code}, ${subdomain}, ${input.name.trim()}, ${input.contactName ?? null},
              ${input.telephone ?? null}, ${input.email ?? null}, 'draft', ${input.environment},
              ${input.countryCode}, ${input.shipmentPrefix}, now(), ${actor.accountId}::uuid
            )
            returning id
          `.execute(transaction)
        ).rows[0]?.id;
        if (companyId === undefined)
          throw new Error("Company creation did not return an identifier");

        await sql`
          insert into company_settings (company_id, base_currency, default_language, timezone)
          values (${companyId}::uuid, 'AED', ${input.defaultLanguage}, ${input.timezone})
        `.execute(transaction);

        // Standard starter roles (Driver Operations, Accountant) — see
        // standard-company-roles.ts for why these two and not more.
        // `is_system = false`: unlike the Company Administrator role created
        // later with the first user, these are ordinary, fully editable
        // roles from the moment the Company exists.
        for (const role of STANDARD_COMPANY_ROLES) {
          const roleId = (
            await sql<{ id: string }>`
              insert into roles (company_id, code, name, description, is_active, is_system)
              values (${companyId}::uuid, ${role.code}, ${role.name}, ${role.description}, true, false)
              returning id
            `.execute(transaction)
          ).rows[0]?.id;
          if (roleId === undefined) throw new Error(`Standard role '${role.code}' was not created`);
          for (const permission of role.permissions) {
            await sql`
              insert into role_permissions (role_id, permission_code)
              values (${roleId}::uuid, ${permission})
            `.execute(transaction);
          }
        }

        let summary: Record<string, unknown> | null = null;
        let areasSeeded = 0;
        // The version actually resolved and applied, not the caller's request
        // -- when the caller names no version, that request was "1 or 2"
        // depending on nothing being said, and the audit must record what
        // really happened rather than repeat the ambiguity.
        let appliedTemplateVersion: number | null = null;
        if (applyTemplate) {
          const applied = await this.importer.apply(transaction, {
            companyId,
            templateCode: input.accountingTemplateCode as string,
            templateVersion:
              input.accountingTemplateVersion ??
              latestTemplateVersion[input.accountingTemplateCode as string] ??
              1,
            actorAccountId: actor.accountId,
            // The NEW Company's own adoption date. The source Company's dates
            // are not in the template and are never consulted.
            effectiveFrom: new Date().toISOString().slice(0, 10),
            businessDayStart: input.businessDayStart,
          });
          summary = { ...applied };
          areasSeeded = applied.areas;
          appliedTemplateVersion = applied.templateVersion;
          await sql`
            update companies
               set accounting_setup_status = 'ready',
                   accounting_template_code = ${applied.templateCode},
                   accounting_template_version = ${applied.templateVersion},
                   accounting_template_sha256 = ${applied.templateSha256},
                   accounting_setup_applied_at = now(),
                   accounting_setup_applied_by_account_id = ${actor.accountId}::uuid,
                   updated_at = now(), version = version + 1
             where id = ${companyId}::uuid
          `.execute(transaction);
        }

        /**
         * Delivery Areas.
         *
         * Seeded as part of the Accounting Template import above -- the
         * template's `areas` section carries the canonical UAE reference
         * list, and the importer creates each row inside the SAME transaction
         * as the rest of the setup, using the `area` reference counter it
         * has just initialised. See `TemplateArea` for why this section does
         * not come from any Company's live data.
         *
         * A Company created with no template (`applyTemplate === false`)
         * gets none, the same way it gets no Chart of Accounts -- there is
         * nothing to seed them from. That path exists for completeness, not
         * for normal onboarding: the Platform Portal always supplies a
         * template.
         */

        // Audit shares the transaction: if the trail cannot be written the
        // Company is not created either.
        await this.auditInTransaction(transaction, {
          action: "platform.company.created",
          companyId,
          actorAccountId: actor.accountId,
          after: {
            companyId,
            code,
            subdomain,
            shipmentPrefix: input.shipmentPrefix,
            name: input.name.trim(),
            environment: input.environment,
            status: "draft",
            accountingTemplate: applyTemplate
              ? `${input.accountingTemplateCode}@${appliedTemplateVersion}`
              : null,
            areasSeeded,
            standardRolesSeeded: STANDARD_COMPANY_ROLES.map((role) => role.code),
          },
          correlationId: actor.correlationId,
          ip: actor.ip,
          userAgent: actor.userAgent,
        });
        if (applyTemplate) {
          await this.auditInTransaction(transaction, {
            action: "platform.company.accounting_setup_applied",
            companyId,
            actorAccountId: actor.accountId,
            after: summary as Record<string, unknown>,
            correlationId: actor.correlationId,
            ip: actor.ip,
            userAgent: actor.userAgent,
          });
        }

        return { companyId, accountingSetup: summary, areasSeeded };
      });
    } catch (error) {
      await this.recordCreationFailure(input, actor, error);
      throw this.translate(error);
    }
  }

  /**
   * A failed creation still leaves a trail.
   *
   * Written outside the rolled-back transaction, because a record that vanished
   * with the failure would answer no question at all — and "why is there no
   * Company?" is exactly the question someone will ask.
   */
  private async recordCreationFailure(
    input: CreateCompanyInput,
    actor: {
      accountId: string;
      correlationId: string;
      ip?: string | undefined;
      userAgent?: string | undefined;
    },
    error: unknown,
  ): Promise<void> {
    await this.audit.recordBestEffort({
      action: "platform.company.creation_failed",
      actorAccountId: actor.accountId,
      companyId: null,
      subjectType: "company",
      subjectId: null,
      after: {
        code: "generated_server_side",
        subdomain: input.subdomain ?? "generated_server_side",
        environment: input.environment,
        result: "failure",
        reason: error instanceof Error ? error.message.slice(0, 500) : "unknown",
      },
      correlationId: actor.correlationId,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  // -------------------------------------------------------------------------
  // Update and lifecycle
  // -------------------------------------------------------------------------

  public async updateProfile(
    companyId: string,
    changes: Record<string, string | null>,
    actor: { accountId: string; correlationId: string },
  ): Promise<void> {
    const before = await this.details(companyId);
    const assignments = [];
    for (const [field, column] of Object.entries({
      name: "name_en",
      nameAr: "name_ar",
      contactName: "contact_name",
      telephone: "telephone",
      email: "email",
      addressEn: "address_en",
      tradeLicenseNumber: "trade_license_number",
      taxRegistrationNumber: "tax_registration_number",
    })) {
      const value = changes[field];
      if (value === undefined) continue;
      assignments.push(sql`${sql.raw(column)} = ${value === null || value === "" ? null : value}`);
    }
    if (assignments.length === 0) return;

    await sql`
      update companies set ${sql.join(assignments, sql`, `)}, updated_at = now(), version = version + 1
       where id = ${companyId}::uuid
    `.execute(this.database);

    await this.audit.record({
      action: "platform.company.profile_updated",
      actorAccountId: actor.accountId,
      companyId,
      subjectType: "company",
      subjectId: companyId,
      before: Object.fromEntries(Object.keys(changes).map((key) => [key, before[key] ?? null])),
      after: changes,
      correlationId: actor.correlationId,
    });
  }

  public async updateShipmentPrefix(
    companyId: string,
    input: { shipmentPrefix: string; expectedVersion: number },
    actor: { accountId: string; correlationId: string },
  ): Promise<Record<string, unknown>> {
    try {
      return await this.transactions.execute(async (transaction) => {
        const before = (
          await sql<{ prefix: string | null; enabledAt: Date | null; version: string }>`
          select shipment_prefix as prefix,shipment_serial_enabled_at as "enabledAt",version::text
            from companies where id=${companyId}::uuid for update
        `.execute(transaction)
        ).rows[0];
        if (before === undefined) throw this.notFound();
        if (Number(before.version) !== input.expectedVersion) {
          throw new ApplicationException(
            "company_version_conflict",
            "Company was changed by another user",
            HttpStatus.CONFLICT,
          );
        }
        if (before.enabledAt !== null) {
          throw new ApplicationException(
            "shipment_prefix_immutable",
            "Shipment prefix is immutable after serial generation is activated",
            HttpStatus.CONFLICT,
          );
        }
        await sql`update companies set shipment_prefix=${input.shipmentPrefix},updated_at=now(),version=version+1
          where id=${companyId}::uuid`.execute(transaction);
        await this.auditInTransaction(transaction, {
          action: "platform.company.shipment_prefix_updated",
          companyId,
          actorAccountId: actor.accountId,
          before: { shipmentPrefix: before.prefix },
          after: { shipmentPrefix: input.shipmentPrefix },
          correlationId: actor.correlationId,
        });
        return {
          shipmentPrefix: input.shipmentPrefix,
          version: input.expectedVersion + 1,
          activated: false,
        };
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  public async activateShipmentSerial(
    companyId: string,
    input: { reason: string; expectedVersion: number },
    actor: { accountId: string; correlationId: string },
  ): Promise<Record<string, unknown>> {
    return this.transactions.execute(async (transaction) => {
      const before = (
        await sql<{ prefix: string | null; enabledAt: Date | null; version: string }>`
        select shipment_prefix as prefix,shipment_serial_enabled_at as "enabledAt",version::text
          from companies where id=${companyId}::uuid for update
      `.execute(transaction)
      ).rows[0];
      if (before === undefined) throw this.notFound();
      if (Number(before.version) !== input.expectedVersion) {
        throw new ApplicationException(
          "company_version_conflict",
          "Company was changed by another user",
          HttpStatus.CONFLICT,
        );
      }
      if (before.prefix === null) {
        throw new ApplicationException(
          "shipment_prefix_required",
          "Assign a shipment prefix before activation",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (before.enabledAt !== null)
        return { shipmentPrefix: before.prefix, activated: true, version: input.expectedVersion };
      const updated = (
        await sql<{ enabledAt: Date; version: string }>`update companies
        set shipment_serial_enabled_at=now(),updated_at=now(),version=version+1
        where id=${companyId}::uuid returning shipment_serial_enabled_at as "enabledAt",version::text
      `.execute(transaction)
      ).rows[0]!;
      await this.auditInTransaction(transaction, {
        action: "platform.company.shipment_serial_activated",
        companyId,
        actorAccountId: actor.accountId,
        before: { activated: false },
        after: { activated: true, shipmentPrefix: before.prefix, reason: input.reason },
        correlationId: actor.correlationId,
      });
      return {
        shipmentPrefix: before.prefix,
        activated: true,
        activatedAt: updated.enabledAt,
        version: Number(updated.version),
      };
    });
  }

  public transition(
    companyId: string,
    target: CompanyStatus,
    reason: string | undefined,
    actor: { accountId: string; correlationId: string },
  ): Promise<void> {
    return this.transactions.execute(async (transaction) => {
      const current = (
        await sql<{ status: CompanyStatus }>`
          select status from companies where id = ${companyId}::uuid for update
        `.execute(transaction)
      ).rows[0];
      if (current === undefined) throw this.notFound();

      /**
       * A refused lifecycle change is recorded, not merely rejected.
       *
       * "Somebody tried to reopen a closed Company" and "somebody tried to
       * activate a Company that was not ready" are exactly the events an
       * investigation needs, and they are invisible if only successes are
       * written. Recorded OUTSIDE the transaction, because the transaction is
       * about to be rolled back by the exception and the entry would go with
       * it — the one case where the audit write must not share the operation's
       * fate.
       */
      const refuse = async (
        code: string,
        message: string,
        failureReason: string,
      ): Promise<never> => {
        await this.audit.recordBestEffort({
          action: "platform.company.transition_denied",
          actorAccountId: actor.accountId,
          companyId,
          subjectType: "company",
          subjectId: companyId,
          reason: reason ?? null,
          before: { status: current.status },
          after: { requestedStatus: target },
          result: "denied",
          failureReason,
          correlationId: actor.correlationId,
        });
        throw new ApplicationException(code, message, HttpStatus.CONFLICT);
      };

      if (!(legalTransitions[current.status] ?? []).includes(target)) {
        await refuse(
          "invalid_status_transition",
          `A Company cannot move from '${current.status}' to '${target}'`,
          "illegal_transition",
        );
      }
      if (target === "active" && current.status === "draft") {
        const readiness = await this.readiness(companyId);
        if (readiness.canActivate !== true) {
          await refuse(
            "company_not_ready",
            `The Company is not ready to activate: ${(readiness.blockedBy as string[]).join(", ")}`,
            `not_ready:${(readiness.blockedBy as string[]).join(",")}`,
          );
        }
      }

      await sql`
        update companies
           set status = ${target},
               status_changed_at = now(),
               status_changed_by_account_id = ${actor.accountId}::uuid,
               status_change_reason = ${reason ?? null},
               activated_at = case when ${target} = 'active' then coalesce(activated_at, now()) else activated_at end,
               suspended_at = case when ${target} = 'suspended' then now() else suspended_at end,
               disabled_at = case when ${target} = 'disabled' then now() else disabled_at end,
               closed_at = case when ${target} = 'closed' then now() else null end,
               updated_at = now(), version = version + 1
         where id = ${companyId}::uuid
      `.execute(transaction);

      await this.auditInTransaction(transaction, {
        action: `platform.company.${target === "active" ? (current.status === "suspended" ? "reactivated" : "activated") : target === "suspended" ? "suspended" : target === "closed" ? "closed" : "disabled"}`,
        companyId,
        actorAccountId: actor.accountId,
        before: { status: current.status },
        after: { status: target, reason: reason ?? null },
        correlationId: actor.correlationId,
        reason,
      });
    });
  }

  public async close(
    companyId: string,
    reason: string,
    confirmation: string,
    actor: { accountId: string; correlationId: string },
  ): Promise<void> {
    const company = (
      await sql<{ code: string }>`select code from companies where id = ${companyId}::uuid`.execute(
        this.database,
      )
    ).rows[0];
    if (company === undefined) throw this.notFound();
    if (confirmation !== `CLOSE ${company.code}`) {
      throw new ApplicationException(
        "company_close_confirmation_mismatch",
        `Type CLOSE ${company.code} to confirm`,
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.transition(companyId, "closed", reason, actor);
  }

  /**
   * One-way move of the Company's environment to 'production'.
   *
   * One-way is the whole point: `environment` is what the Company data reset
   * gates on, so a route that could move a Company OUT of production would
   * quietly turn "production data can never be reset" into "production data
   * can be reset in two requests". No such route exists, and this method
   * refuses a Company that is already in production rather than succeeding
   * silently, so the audit trail records exactly one transition per Company.
   */
  public moveToProduction(
    companyId: string,
    reason: string | undefined,
    actor: { accountId: string; correlationId: string },
  ): Promise<void> {
    return this.transactions.execute(async (transaction) => {
      const current = (
        await sql<{ environment: string }>`
          select environment from companies where id = ${companyId}::uuid for update
        `.execute(transaction)
      ).rows[0];
      if (current === undefined) throw this.notFound();
      if (current.environment === "production") {
        throw new ApplicationException(
          "company_already_production",
          "The Company is already in production",
          HttpStatus.CONFLICT,
        );
      }

      await sql`
        update companies
           set environment = 'production', updated_at = now(), version = version + 1
         where id = ${companyId}::uuid
      `.execute(transaction);

      await this.auditInTransaction(transaction, {
        action: "platform.company.moved_to_production",
        companyId,
        actorAccountId: actor.accountId,
        before: { environment: current.environment },
        after: { environment: "production", reason: reason ?? null },
        correlationId: actor.correlationId,
        reason,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async resolveSubdomain(
    database: Kysely<DatabaseSchema>,
    name: string,
    override?: string,
  ): Promise<string> {
    if (override !== undefined) {
      this.assertSubdomain(override);
      return override.trim().toLowerCase();
    }
    const base = suggestCompanySubdomain(name);
    if (base === "") {
      throw new ApplicationException(
        "subdomain_required",
        "Enter a URL-safe subdomain for this Company name",
        HttpStatus.BAD_REQUEST,
      );
    }
    this.assertSubdomain(base);
    await sql`select pg_advisory_xact_lock(hashtext(${`platform-company-subdomain:${base}`}))`.execute(
      database,
    );
    const existing = (
      await sql<{ subdomain: string }>`
        select subdomain from companies
         where lower(subdomain) = ${base} or lower(subdomain) like ${`${base}-%`}
      `.execute(database)
    ).rows.map((row) => row.subdomain.toLowerCase());
    if (!existing.includes(base)) return base;
    for (let suffix = 2; suffix < 1_000_000; suffix += 1) {
      const suffixText = String(suffix);
      const candidate = `${base.slice(0, 62 - suffixText.length)}-${suffixText}`;
      if (!existing.includes(candidate)) return candidate;
    }
    throw new ApplicationException(
      "subdomain_unavailable",
      "No subdomain is available for this Company name",
      HttpStatus.CONFLICT,
    );
  }

  private assertSubdomain(subdomain: string): void {
    const value = subdomain.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
      throw new ApplicationException(
        "subdomain_invalid",
        "The subdomain must be a valid DNS label",
        HttpStatus.BAD_REQUEST,
      );
    }
    // One shared list with the host resolver and the database constraint.
    if (isReservedCompanySubdomain(value)) {
      throw new ApplicationException(
        "subdomain_reserved",
        `'${value}' is a reserved subdomain and cannot be used by a Company`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Writes the audit row inside the caller's transaction.
   *
   * `PlatformAuditService` writes against the pooled connection, which is right
   * for sign-in but wrong here: a Company creation whose audit row could not be
   * written must not be created at all, and that only holds if the two share
   * one transaction.
   */
  private async auditInTransaction(
    transaction: Transaction<DatabaseSchema>,
    input: {
      action: string;
      companyId: string;
      actorAccountId: string;
      before?: Record<string, unknown> | undefined;
      after?: Record<string, unknown> | undefined;
      correlationId: string;
      reason?: string | undefined;
      ip?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id, reason,
        before_data, after_data, correlation_id, ip_address, user_agent, actor_role, source,
        result, source_application
      ) values (
        ${input.companyId}::uuid, ${input.actorAccountId}::uuid, ${input.action}, 'company',
        ${input.companyId}, ${input.reason ?? null},
        ${input.before === undefined ? null : JSON.stringify(redactSensitive(input.before))}::jsonb,
        ${input.after === undefined ? null : JSON.stringify(redactSensitive(input.after))}::jsonb,
        ${input.correlationId}, ${input.ip ?? null}::inet, ${input.userAgent ?? null},
        'platform_administrator', 'platform_portal',
        -- This writer runs inside the operation's transaction, so it is only
        -- reached once the operation has succeeded. Refusals are recorded by
        -- the refuse helper above, outside the transaction that is about to
        -- roll back. (No backticks in SQL comments: they terminate the
        -- surrounding template literal.)
        'success', 'platform-web'
      )
    `.execute(transaction);
  }

  private notFound(): ApplicationException {
    return new ApplicationException(
      "company_not_found",
      "The requested Company does not exist",
      HttpStatus.NOT_FOUND,
    );
  }

  /** Turns database and registry failures into meaningful API errors. */
  private translate(error: unknown): unknown {
    if (error instanceof ApplicationException) return error;
    if (error instanceof TemplateNotApprovedError) {
      return new ApplicationException(
        "accounting_template_not_approved",
        error.message,
        HttpStatus.BAD_REQUEST,
      );
    }
    const code = (error as { code?: string; constraint?: string }).code;
    const constraint = (error as { constraint?: string }).constraint ?? "";
    if (code === "23505") {
      if (constraint.includes("code")) {
        return new ApplicationException(
          "company_code_taken",
          "That Company code is already in use",
          HttpStatus.CONFLICT,
        );
      }
      if (constraint.includes("subdomain")) {
        return new ApplicationException(
          "company_subdomain_taken",
          "That subdomain is already in use",
          HttpStatus.CONFLICT,
        );
      }
      return new ApplicationException(
        "company_duplicate",
        "That Company already exists",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "companies_subdomain_not_reserved") {
      return new ApplicationException(
        "subdomain_reserved",
        "That subdomain is reserved and cannot be used by a Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (error instanceof Error && error.message.includes("Accounting setup validation failed")) {
      return new ApplicationException(
        "accounting_setup_failed",
        error.message,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return error;
  }
}

type ReadinessState = "complete" | "incomplete" | "optional";

function item(
  key: string,
  label: string,
  required: boolean,
  complete: boolean,
  note?: string,
): { key: string; label: string; required: boolean; state: ReadinessState; note: string | null } {
  return {
    key,
    label,
    required,
    state: complete ? "complete" : required ? "incomplete" : "optional",
    note: complete ? null : (note ?? null),
  };
}
