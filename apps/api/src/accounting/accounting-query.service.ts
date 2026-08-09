import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import {
  accountingAccountClasses,
  accountingAccountTypes,
  accountingAutomaticPostingEnabledByDefault,
  accountingComponentTypes,
  accountingControlAccountTypes,
  accountingCurrencies,
  accountingEventTypes,
  accountingFiscalPeriodStatuses,
  accountingFiscalYearStatuses,
  accountingJournalSources,
  accountingJournalStatuses,
  accountingJournalTypes,
  accountingNormalBalances,
  accountingPermissionCodes,
  accountingRequiredMappingGroups,
} from "./accounting.constants.js";
import type {
  AccountingMappingAreaReadiness,
  AccountingMappingIssue,
} from "./accounting.contracts.js";
import { AccountingFoundationRepository } from "./accounting-foundation.repository.js";

@Injectable()
export class AccountingQueryService {
  public constructor(
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(AccountingFoundationRepository)
    private readonly repository: AccountingFoundationRepository,
  ) {}

  public async configuration() {
    const companyId = this.tenants.current().companyId;
    return (
      (await this.repository.configuration(companyId)) ?? {
        accountingEnabled: false,
        automaticPostingEnabled: false,
        baseCurrency: "AED",
        companyId,
        configured: false,
        defaultAccountingMethod: "accrual",
        fiscalYearStartMonth: 1,
      }
    );
  }

  public accounts(input: { readonly activeOnly?: string; readonly search?: string }) {
    return this.repository.accounts(this.tenants.current().companyId, {
      activeOnly: input.activeOnly !== "false",
      ...(input.search === undefined ? {} : { search: input.search }),
    });
  }

  public async account(accountId: string) {
    const account = await this.repository.account(this.tenants.current().companyId, accountId);
    if (account === undefined) {
      throw new ApplicationException(
        "accounting_account_not_found",
        "The Accounting Account was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return account;
  }

  public fiscalYears() {
    return this.repository.fiscalYears(this.tenants.current().companyId);
  }

  public async fiscalYear(fiscalYearId: string) {
    const years = await this.repository.fiscalYears(this.tenants.current().companyId);
    const year = years.find((item) => item.id === fiscalYearId);
    if (year === undefined) {
      throw new ApplicationException(
        "accounting_fiscal_year_not_found",
        "The Fiscal Year was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return year;
  }

  public fiscalPeriods(fiscalYearId?: string) {
    if (
      fiscalYearId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        fiscalYearId,
      )
    ) {
      throw new ApplicationException(
        "accounting_fiscal_year_not_found",
        "The Fiscal Year identifier is invalid",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.repository.fiscalPeriods(this.tenants.current().companyId, fiscalYearId);
  }

  public async fiscalPeriod(periodId: string) {
    const periods = await this.repository.fiscalPeriods(this.tenants.current().companyId);
    const period = periods.find((item) => item.id === periodId);
    if (period === undefined) {
      throw new ApplicationException(
        "accounting_fiscal_period_not_found",
        "The Fiscal Period was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return period;
  }

  public async mappingCompleteness(effectiveOn?: string) {
    if (
      effectiveOn !== undefined &&
      (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(effectiveOn) ||
        Number.isNaN(Date.parse(`${effectiveOn}T00:00:00Z`)) ||
        new Date(`${effectiveOn}T00:00:00Z`).toISOString().slice(0, 10) !== effectiveOn)
    ) {
      throw new ApplicationException(
        "accounting_mapping_effective_date_invalid",
        "The Accounting mapping effective date is invalid",
        HttpStatus.BAD_REQUEST,
      );
    }
    const companyId = this.tenants.current().companyId;
    const timezone = await this.repository.companyTimezone(companyId);
    const date =
      effectiveOn ??
      (() => {
        const parts = new Intl.DateTimeFormat("en", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date())
          .reduce<Record<string, string>>((result, part) => {
            result[part.type] = part.value;
            return result;
          }, {});
        return `${parts.year}-${parts.month}-${parts.day}`;
      })();
    const mappings = await this.repository.effectiveMappings(companyId, date);
    const configured = new Set(mappings.map((mapping) => mapping.mappingKey));
    const issuesByKey = new Map<string, AccountingMappingIssue[]>();
    for (const mapping of mappings) {
      const issues = issuesByKey.get(mapping.mappingKey) ?? [];
      if (!mapping.accountActive) {
        issues.push({
          ...(mapping.accountId === null ? {} : { accountId: mapping.accountId }),
          code: "inactive_account",
          mappingKey: mapping.mappingKey,
        });
      }
      if (!mapping.accountPosting) {
        issues.push({
          ...(mapping.accountId === null ? {} : { accountId: mapping.accountId }),
          code: "summary_account",
          mappingKey: mapping.mappingKey,
        });
      }
      issuesByKey.set(mapping.mappingKey, issues);
    }

    const areas: AccountingMappingAreaReadiness[] = Object.entries(
      accountingRequiredMappingGroups,
    ).map(([area, required]) => {
      const configuredMappingKeys = required.filter((key) => configured.has(key));
      const missingMappingKeys = required.filter((key) => !configured.has(key));
      const issues = required.flatMap((key) => issuesByKey.get(key) ?? []);
      return {
        area,
        configuredMappingKeys,
        issues,
        missingMappingKeys,
        ready: missingMappingKeys.length === 0 && issues.length === 0,
        requiredMappingKeys: required,
      };
    });
    const configuration = await this.configuration();
    return {
      accountingConfigurationComplete:
        "configured" in configuration && configuration.configured === false
          ? false
          : areas.every((area) => area.ready),
      automaticPostingEnabled:
        "automaticPostingEnabled" in configuration
          ? configuration.automaticPostingEnabled
          : accountingAutomaticPostingEnabledByDefault,
      effectiveOn: date,
      timezone,
      operationalAreas: areas,
      readyForAutomaticPosting: areas.every((area) => area.ready),
    };
  }

  public metadata() {
    return {
      accountClasses: accountingAccountClasses,
      accountTypes: accountingAccountTypes,
      automaticPostingEnabledByDefault: accountingAutomaticPostingEnabledByDefault,
      componentTypes: accountingComponentTypes,
      controlAccountTypes: accountingControlAccountTypes,
      currencies: accountingCurrencies,
      eventTypes: accountingEventTypes,
      fiscalPeriodStatuses: accountingFiscalPeriodStatuses,
      fiscalYearStatuses: accountingFiscalYearStatuses,
      journalSources: accountingJournalSources,
      journalStatuses: accountingJournalStatuses,
      journalTypes: accountingJournalTypes,
      normalBalances: accountingNormalBalances,
      permissionCodes: accountingPermissionCodes,
      requiredMappings: accountingRequiredMappingGroups,
    };
  }
}
