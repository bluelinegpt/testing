import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

export interface AccountingConfigurationRecord {
  readonly accountingEnabled: boolean;
  readonly automaticPostingEnabled: boolean;
  readonly automaticPostingAreas: readonly string[];
  readonly baseCurrency: string;
  readonly companyId: string;
  readonly defaultAccountingMethod: string;
  readonly fiscalYearStartMonth: number;
  readonly manualAccountingActivationDate: string | null;
  readonly manualAccountingEnabledAt: string | null;
  readonly version: string;
}

export interface AccountingAccountRecord {
  readonly accountClass: string;
  readonly accountType: string;
  readonly code: string;
  readonly controlAccountType: string | null;
  readonly description: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly isContraAccount: boolean;
  readonly isControlAccount: boolean;
  readonly isPostingAccount: boolean;
  readonly isSystemAccount: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly normalBalance: string;
  readonly parentAccountId: string | null;
  readonly systemPurpose: string | null;
}

export interface AccountingMappingRecord {
  readonly accountActive: boolean;
  readonly accountId: string | null;
  readonly accountPosting: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly mappingKey: string;
}

@Injectable()
export class AccountingFoundationRepository {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async configuration(
    companyId: string,
  ): Promise<AccountingConfigurationRecord | undefined> {
    const result = await sql<AccountingConfigurationRecord>`
      select company_id as "companyId",
             accounting_enabled as "accountingEnabled",
             automatic_posting_enabled as "automaticPostingEnabled",
             automatic_posting_areas as "automaticPostingAreas",
             base_currency as "baseCurrency",
             fiscal_year_start_month as "fiscalYearStartMonth",
             default_accounting_method as "defaultAccountingMethod",
             manual_accounting_activation_date::text as "manualAccountingActivationDate",
             manual_accounting_enabled_at as "manualAccountingEnabledAt",
             version::text as version
        from accounting_configurations
       where company_id = ${companyId}::uuid
    `.execute(this.database);
    return result.rows[0];
  }

  public async companyTimezone(companyId: string): Promise<string> {
    const result = await sql<{ timezone: string }>`
      select timezone from company_settings where company_id = ${companyId}::uuid
    `.execute(this.database);
    return result.rows[0]?.timezone ?? "Asia/Dubai";
  }

  public async accounts(
    companyId: string,
    input: { readonly activeOnly: boolean; readonly search?: string },
  ): Promise<readonly AccountingAccountRecord[]> {
    const search = input.search?.trim() ?? "";
    const result = await sql<AccountingAccountRecord>`
      select id, code, name_en as "nameEn", name_ar as "nameAr",
             account_type as "accountType", account_class as "accountClass",
             parent_account_id as "parentAccountId",
             is_posting_account as "isPostingAccount",
             is_control_account as "isControlAccount",
             control_account_type as "controlAccountType",
             is_system_account as "isSystemAccount",
             system_purpose as "systemPurpose",
             is_contra_account as "isContraAccount",
             is_active as "isActive", normal_balance as "normalBalance",
             description, effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo"
        from chart_of_accounts
       where company_id = ${companyId}::uuid
         and (${input.activeOnly} = false or is_active)
         and (
           ${search} = ''
           or code ilike ${`%${search}%`}
           or name_en ilike ${`%${search}%`}
           or coalesce(name_ar, '') ilike ${`%${search}%`}
         )
       order by code, id
    `.execute(this.database);
    return result.rows;
  }

  public async account(
    companyId: string,
    accountId: string,
  ): Promise<AccountingAccountRecord | undefined> {
    const result = await sql<AccountingAccountRecord>`
      select id, code, name_en as "nameEn", name_ar as "nameAr",
             account_type as "accountType", account_class as "accountClass",
             parent_account_id as "parentAccountId",
             is_posting_account as "isPostingAccount",
             is_control_account as "isControlAccount",
             control_account_type as "controlAccountType",
             is_system_account as "isSystemAccount",
             system_purpose as "systemPurpose",
             is_contra_account as "isContraAccount",
             is_active as "isActive", normal_balance as "normalBalance",
             description, effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo"
        from chart_of_accounts
       where id = ${accountId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    return result.rows[0];
  }

  public async fiscalYears(companyId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await sql<Record<string, unknown>>`
      select id, fiscal_year_code as "fiscalYearCode", name,
             start_date::text as "startDate", end_date::text as "endDate",
             status, created_at as "createdAt", opened_at as "openedAt",
             closed_at as "closedAt", reopened_at as "reopenedAt",
             close_reason as "closeReason", reopen_reason as "reopenReason",
             version::text as version
        from fiscal_years
       where company_id = ${companyId}::uuid
       order by start_date desc, id
    `.execute(this.database);
    return result.rows;
  }

  public async fiscalPeriods(
    companyId: string,
    fiscalYearId?: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await sql<Record<string, unknown>>`
      select p.id, p.fiscal_year_id as "fiscalYearId",
             p.period_number as "periodNumber", p.period_code as "periodCode",
             p.name, p.period_start::text as "startDate",
             p.period_end::text as "endDate", p.status,
             p.is_adjustment_period as "isAdjustmentPeriod",
             p.opened_at as "openedAt", p.closed_at as "closedAt",
             p.reopened_at as "reopenedAt", p.close_reason as "closeReason",
             p.reopen_reason as "reopenReason", p.version::text as version
        from accounting_periods p
       where p.company_id = ${companyId}::uuid
         and (
           ${fiscalYearId ?? null}::uuid is null
           or p.fiscal_year_id = ${fiscalYearId ?? null}::uuid
         )
       order by p.period_start desc, p.period_number, p.id
    `.execute(this.database);
    return result.rows;
  }

  public async effectiveMappings(
    companyId: string,
    effectiveOn: string,
  ): Promise<readonly AccountingMappingRecord[]> {
    const result = await sql<AccountingMappingRecord>`
      select m.mapping_key as "mappingKey",
             m.effective_from::text as "effectiveFrom",
             m.effective_to::text as "effectiveTo",
             account_refs.account_id as "accountId",
             coalesce(a.is_active, false) as "accountActive",
             coalesce(a.is_posting_account, false) as "accountPosting"
        from account_mappings m
        left join lateral (
          select account_id
            from unnest(array[
              m.debit_account_id, m.credit_account_id, m.vat_account_id,
              m.fee_account_id, m.expense_account_id, m.payable_account_id
            ]) account_id
           where account_id is not null
        ) account_refs on true
        left join chart_of_accounts a
          on a.id = account_refs.account_id and a.company_id = m.company_id
       where m.company_id = ${companyId}::uuid and m.is_active
         and m.effective_from <= ${effectiveOn}::date
         and coalesce(m.effective_to, 'infinity'::date) >= ${effectiveOn}::date
       order by m.mapping_key, m.effective_from desc
    `.execute(this.database);
    return result.rows;
  }
}
