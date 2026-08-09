import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingManagementService } from "./accounting-management.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import {
  accountingMandatoryMappings,
  type AccountingMandatoryMappingDefinition,
} from "./accounting-setup.constants.js";
import type {
  AccountingActivationDto,
  AccountingActivationPreviewDto,
  AccountingAreaChangeDto,
  AccountingMappingDecisionDto,
  AccountingZeroOpeningDto,
} from "./accounting-setup.dto.js";
import { AutomaticPostingService } from "./automatic-posting.service.js";

interface SetupAccount {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly accountType: string;
  readonly accountClass: string;
  readonly isPosting: boolean;
  readonly isControl: boolean;
  readonly controlType: string | null;
  readonly isSystem: boolean;
  readonly normalBalance: string;
  readonly isActive: boolean;
  readonly parentId: string | null;
  readonly level: number;
}

interface SetupMapping {
  readonly id: string;
  readonly mappingKey: string;
  readonly creditAccountId: string | null;
  readonly debitAccountId: string | null;
  readonly expenseAccountId: string | null;
  readonly feeAccountId: string | null;
  readonly payableAccountId: string | null;
  readonly vatAccountId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const currentDate = () => {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const normalize = (value: string | null) =>
  (value ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const mappedAccountId = (
  definition: AccountingMandatoryMappingDefinition,
  mapping: SetupMapping | undefined,
) => mapping?.[definition.field] ?? null;

@Injectable()
export class AccountingSetupService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(AccountingManagementService)
    private readonly management: AccountingManagementService,
    @Inject(AutomaticPostingService)
    private readonly automaticPosting: AutomaticPostingService,
  ) {}

  private conflict(code: string, message = code): never {
    throw new ApplicationException(code, message, HttpStatus.CONFLICT);
  }

  private validateDate(value: string): void {
    if (!datePattern.test(value)) {
      throw new ApplicationException(
        "accounting_setup_invalid_effective_date",
        "A valid date-only Accounting date is required",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async source(
    database: Kysely<DatabaseSchema>,
  ): Promise<{ accounts: readonly SetupAccount[]; mappings: readonly SetupMapping[] }> {
    const { companyId } = this.support.context();
    const accounts = await sql<SetupAccount>`
      with recursive account_tree as (
        select a.id,0 as level from chart_of_accounts a
         where a.company_id=${companyId}::uuid and a.parent_account_id is null
        union all
        select child.id,parent.level+1
          from chart_of_accounts child join account_tree parent
            on child.parent_account_id=parent.id
         where child.company_id=${companyId}::uuid
      )
      select a.id,a.code,a.name_en as "nameEn",a.name_ar as "nameAr",
             a.account_type as "accountType",a.account_class as "accountClass",
             a.is_posting_account as "isPosting",a.is_control_account as "isControl",
             a.control_account_type as "controlType",a.is_system_account as "isSystem",
             a.normal_balance as "normalBalance",a.is_active as "isActive",
             a.parent_account_id as "parentId",coalesce(t.level,0)::int as level
        from chart_of_accounts a left join account_tree t on t.id=a.id
       where a.company_id=${companyId}::uuid
       order by a.code,a.id
    `.execute(database);
    const mappings = await sql<SetupMapping>`
      select m.id,m.mapping_key as "mappingKey",
             m.debit_account_id as "debitAccountId",
             m.credit_account_id as "creditAccountId",
             m.vat_account_id as "vatAccountId",
             m.fee_account_id as "feeAccountId",
             m.expense_account_id as "expenseAccountId",
             m.payable_account_id as "payableAccountId",
             m.effective_from::text as "effectiveFrom",
             m.effective_to::text as "effectiveTo",m.is_active as "isActive"
        from account_mappings m where m.company_id=${companyId}::uuid
       order by m.mapping_key,m.effective_from,m.id
    `.execute(database);
    return { accounts: accounts.rows, mappings: mappings.rows };
  }

  private compatibility(
    definition: AccountingMandatoryMappingDefinition,
    account: SetupAccount,
  ): { compatible: boolean; errors: string[] } {
    const expectedNormalBalance = ["asset", "expense"].includes(definition.accountType)
      ? "debit"
      : "credit";
    const errors = [
      ...(account.isActive ? [] : ["inactive_account"]),
      ...(account.isPosting ? [] : ["summary_account"]),
      ...(account.accountType === definition.accountType ? [] : ["incompatible_account_type"]),
      ...(definition.accountClasses.includes(account.accountClass)
        ? []
        : ["incompatible_account_class"]),
      ...(account.normalBalance === expectedNormalBalance ? [] : ["incompatible_normal_balance"]),
      ...(definition.controlType === undefined ||
      (account.isControl && account.controlType === definition.controlType)
        ? []
        : ["incompatible_control_account"]),
    ];
    return { compatible: errors.length === 0, errors };
  }

  private score(
    definition: AccountingMandatoryMappingDefinition,
    account: SetupAccount,
  ): { evidence: string[]; score: number } {
    const name = normalize(`${account.nameEn} ${account.nameAr ?? ""}`);
    const synonyms = definition.synonyms.map(normalize);
    const exact = synonyms.some((item) => name === item);
    const partial = synonyms.some((item) => item.length > 2 && name.includes(item));
    const evidence = [
      "compatible_account_type",
      "compatible_account_class",
      "compatible_normal_balance",
      "active_posting_account",
      ...(exact ? ["exact_normalized_name"] : []),
      ...(!exact && partial ? ["partial_normalized_name"] : []),
      ...(account.isSystem ? ["system_account"] : []),
      ...(account.isControl ? ["control_account"] : []),
      ...(account.parentId !== null ? ["posting_hierarchy"] : []),
      ...(/^(1|2|3|4|5)\d{2,}$/.test(account.code) ? ["supporting_code_pattern"] : []),
    ];
    return {
      evidence,
      score: Math.min(
        100,
        45 +
          (exact ? 35 : partial ? 22 : 0) +
          (account.isSystem ? 5 : 0) +
          (account.isControl ? 5 : 0) +
          (account.parentId !== null ? 5 : 0),
      ),
    };
  }

  private suggestionId(
    companyId: string,
    key: string,
    effectiveOn: string,
    accountId: string | null,
  ) {
    return createHash("sha256")
      .update(`${companyId}:${key}:${effectiveOn}:${accountId ?? "none"}`)
      .digest("hex")
      .slice(0, 32);
  }

  public async mappingSuggestions(effectiveOn = currentDate()) {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    this.validateDate(effectiveOn);
    const { companyId } = this.support.context();
    const { accounts, mappings } = await this.source(this.database);
    const evaluatedAt = new Date().toISOString();
    const generated = accountingMandatoryMappings.map((definition) => {
      const current = mappings.find(
        (mapping) =>
          mapping.mappingKey === definition.key &&
          mapping.isActive &&
          mapping.effectiveFrom <= effectiveOn &&
          (mapping.effectiveTo === null || mapping.effectiveTo >= effectiveOn),
      );
      const currentAccountId = mappedAccountId(definition, current);
      const currentAccount = accounts.find((account) => account.id === currentAccountId);
      const currentCompatibility =
        currentAccount === undefined
          ? {
              compatible: false,
              errors: current === undefined ? ["mapping_missing"] : ["mapped_account_missing"],
            }
          : this.compatibility(definition, currentAccount);
      const candidates = accounts
        .map((account) => ({
          account,
          compatibility: this.compatibility(definition, account),
          ...this.score(definition, account),
        }))
        .filter((candidate) => candidate.compatibility.compatible)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.account.code.localeCompare(right.account.code) ||
            left.account.id.localeCompare(right.account.id),
        );
      const candidate = candidates[0];
      const competing =
        candidate !== undefined &&
        candidates[1] !== undefined &&
        candidate.score - candidates[1].score < 10;
      const confidence =
        candidate === undefined
          ? "no_safe_suggestion"
          : candidate.score >= 85 && !competing
            ? "high"
            : candidate.score >= 65
              ? "medium"
              : "low";
      const suggestedId = currentCompatibility.compatible
        ? currentAccount!.id
        : (candidate?.account.id ?? null);
      return {
        suggestionId: this.suggestionId(companyId, definition.key, effectiveOn, suggestedId),
        companyId,
        operationalArea: definition.area,
        mappingKey: definition.key,
        mappingLabel: definition.label,
        mandatoryStatus: definition.requirement,
        currentMapping:
          current === undefined
            ? null
            : {
                ...current,
                account:
                  currentAccount === undefined
                    ? null
                    : {
                        id: currentAccount.id,
                        code: currentAccount.code,
                        nameEn: currentAccount.nameEn,
                        nameAr: currentAccount.nameAr,
                      },
              },
        suggestedAccount:
          candidate === undefined
            ? null
            : {
                id: candidate.account.id,
                code: candidate.account.code,
                nameEn: candidate.account.nameEn,
                nameAr: candidate.account.nameAr,
                accountType: candidate.account.accountType,
                accountClass: candidate.account.accountClass,
                isPostingAccount: candidate.account.isPosting,
                isActive: candidate.account.isActive,
              },
        confidence,
        confidenceScore: candidate?.score ?? 0,
        confidenceReason:
          candidate === undefined
            ? "No active compatible Posting Account exists"
            : competing
              ? "More than one similarly scored compatible Account exists"
              : candidate.evidence.join(", "),
        evidence: candidate?.evidence ?? [],
        compatibilityStatus: candidate === undefined ? "incompatible" : "compatible",
        compatibilityErrors: candidate?.compatibility.errors ?? ["no_compatible_account"],
        alternativeCandidates: candidates.slice(1, 6).map((item) => ({
          id: item.account.id,
          code: item.account.code,
          nameEn: item.account.nameEn,
          nameAr: item.account.nameAr,
          accountType: item.account.accountType,
          accountClass: item.account.accountClass,
          score: item.score,
        })),
        effectiveFromProposal: effectiveOn,
        effectiveToProposal: null,
        readinessImpact: definition.readinessImpact,
        status: currentCompatibility.compatible
          ? "already_configured"
          : current === undefined
            ? "suggested"
            : "invalid_existing_mapping",
        evaluatedAt,
      };
    });
    const decisions = await sql<{ action: string; subjectId: string }>`
      select distinct on(subject_id) subject_id as "subjectId",action
        from audit_events
       where company_id=${companyId}::uuid
         and subject_type='accounting_mapping_suggestion'
         and subject_id=any(${generated.map((item) => item.suggestionId)}::text[])
       order by subject_id,occurred_at desc
    `.execute(this.database);
    const suggestions = generated.map((item) => {
      if (item.status === "already_configured" || item.status === "invalid_existing_mapping") {
        return item;
      }
      const decision = decisions.rows.find((row) => row.subjectId === item.suggestionId);
      const status = decision?.action.split(".").at(-1);
      return status === "rejected" || status === "unresolved" || status === "not_applicable"
        ? { ...item, status }
        : item;
    });
    await this.support.audit(this.database, {
      action: "accounting.setup.mapping_analysis.generated",
      after: {
        effectiveOn,
        evaluatedCount: suggestions.length,
        configuredCount: suggestions.filter((item) => item.status === "already_configured").length,
        noSafeSuggestionCount: suggestions.filter(
          (item) => item.confidence === "no_safe_suggestion",
        ).length,
      },
      correlationId: randomUUID(),
      subjectId: companyId,
      subjectType: "accounting_setup",
    });
    return { deterministic: true, aiUsed: false, effectiveOn, evaluatedAt, items: suggestions };
  }

  public async mappingIssues(effectiveOn = currentDate()) {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    this.validateDate(effectiveOn);
    const { accounts, mappings } = await this.source(this.database);
    const { companyId } = this.support.context();
    const period = await sql<{ periodEnd: string | null }>`
      select period_end::text as "periodEnd"
        from accounting_periods
       where company_id=${companyId}::uuid
         and ${effectiveOn}::date between period_start and period_end
       order by period_start desc limit 1
    `.execute(this.database);
    const periodEnd = period.rows[0]?.periodEnd ?? null;
    const issues: Record<string, unknown>[] = [];
    for (const definition of accountingMandatoryMappings) {
      const rows = mappings.filter(
        (mapping) => mapping.mappingKey === definition.key && mapping.isActive,
      );
      const current = rows.filter(
        (mapping) =>
          mapping.effectiveFrom <= effectiveOn &&
          (mapping.effectiveTo === null || mapping.effectiveTo >= effectiveOn),
      );
      if (current.length === 0) {
        const beginsLater = rows
          .filter((mapping) => mapping.effectiveFrom > effectiveOn)
          .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))[0];
        issues.push({
          mappingKey: definition.key,
          operationalArea: definition.area,
          issueType:
            rows.length === 0
              ? "missing_mapping"
              : beginsLater === undefined
                ? "current_date_gap"
                : "mapping_begins_after_activation",
          effectiveFrom: effectiveOn,
          severity: "critical",
          activationBlocker: definition.requirement === "mandatory",
          automaticPostingBlocker: true,
          requiredAction: "create_effective_mapping",
        });
      }
      for (const mapping of current) {
        if (periodEnd !== null && mapping.effectiveTo !== null && mapping.effectiveTo < periodEnd) {
          issues.push({
            mappingKey: definition.key,
            operationalArea: definition.area,
            issueType: "mapping_ends_before_period_end",
            effectiveFrom: mapping.effectiveFrom,
            effectiveTo: mapping.effectiveTo,
            requiredPeriodEnd: periodEnd,
            existingMappings: [mapping],
            severity: "critical",
            activationBlocker: definition.requirement === "mandatory",
            automaticPostingBlocker: true,
            requiredAction: "extend_or_create_successor_mapping",
          });
        }
      }
      if (current.length > 1) {
        issues.push({
          mappingKey: definition.key,
          operationalArea: definition.area,
          issueType: "overlap",
          existingMappings: current,
          severity: "critical",
          activationBlocker: true,
          automaticPostingBlocker: true,
          requiredAction: "close_overlapping_mapping",
        });
      }
      for (const mapping of rows) {
        const account = accounts.find((item) => item.id === mappedAccountId(definition, mapping));
        const compatibility =
          account === undefined
            ? { compatible: false, errors: ["mapped_account_missing"] }
            : this.compatibility(definition, account);
        for (const error of compatibility.errors) {
          issues.push({
            mappingKey: definition.key,
            operationalArea: definition.area,
            issueType: error,
            existingMappings: [mapping],
            severity: "critical",
            activationBlocker: definition.requirement === "mandatory",
            automaticPostingBlocker: true,
            requiredAction: "replace_mapping",
          });
        }
        if (mapping.effectiveTo !== null && mapping.effectiveTo < effectiveOn) {
          issues.push({
            mappingKey: definition.key,
            operationalArea: definition.area,
            issueType: "expired_mapping",
            effectiveTo: mapping.effectiveTo,
            existingMappings: [mapping],
            severity: "warning",
            activationBlocker: current.length === 0,
            automaticPostingBlocker: current.length === 0,
            requiredAction: "create_successor_mapping",
          });
        }
      }
      const ordered = [...rows].sort((left, right) =>
        left.effectiveFrom.localeCompare(right.effectiveFrom),
      );
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]!;
        const next = ordered[index]!;
        if (previous.effectiveTo !== null && previous.effectiveTo >= next.effectiveFrom) {
          issues.push({
            mappingKey: definition.key,
            operationalArea: definition.area,
            issueType: "overlap",
            effectiveFrom: next.effectiveFrom,
            existingMappings: [previous, next],
            severity: "critical",
            activationBlocker: true,
            automaticPostingBlocker: true,
            requiredAction: "close_overlapping_mapping",
          });
        } else if (previous.effectiveTo !== null) {
          const nextDay = new Date(`${previous.effectiveTo}T00:00:00Z`);
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          if (nextDay.toISOString().slice(0, 10) < next.effectiveFrom) {
            issues.push({
              mappingKey: definition.key,
              operationalArea: definition.area,
              issueType: "future_gap",
              effectiveFrom: nextDay.toISOString().slice(0, 10),
              effectiveTo: next.effectiveFrom,
              existingMappings: [previous, next],
              severity: "warning",
              activationBlocker: false,
              automaticPostingBlocker: true,
              requiredAction: "close_effective_date_gap",
            });
          }
        }
      }
    }
    const response = {
      effectiveOn,
      counts: {
        total: issues.length,
        blockers: issues.filter((item) => item.activationBlocker === true).length,
        missing: issues.filter((item) => item.issueType === "missing_mapping").length,
        invalid: issues.filter((item) =>
          [
            "mapped_account_missing",
            "inactive_account",
            "summary_account",
            "incompatible_account_type",
            "incompatible_account_class",
            "incompatible_control_account",
            "incompatible_normal_balance",
          ].includes(String(item.issueType)),
        ).length,
        inactive: issues.filter((item) => item.issueType === "inactive_account").length,
        gaps: issues.filter(
          (item) =>
            String(item.issueType).includes("gap") ||
            item.issueType === "mapping_begins_after_activation" ||
            item.issueType === "mapping_ends_before_period_end",
        ).length,
        overlaps: issues.filter((item) => item.issueType === "overlap").length,
      },
      items: issues,
      evaluatedAt: new Date().toISOString(),
    };
    await this.support.audit(this.database, {
      action: "accounting.setup.mapping_issues.identified",
      after: { effectiveOn, counts: response.counts },
      correlationId: randomUUID(),
      subjectId: companyId,
      subjectType: "accounting_setup",
    });
    return response;
  }

  public async decideSuggestion(
    suggestionId: string,
    input: AccountingMappingDecisionDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    const analysis = await this.mappingSuggestions(input.effectiveFrom);
    const suggestion = analysis.items.find((item) => item.suggestionId === suggestionId);
    if (suggestion === undefined) {
      this.conflict(
        "accounting_setup_suggestion_not_found",
        "The mapping suggestion is stale or unavailable",
      );
    }
    if (input.decision === "not_applicable") {
      const definition = accountingMandatoryMappings.find(
        (item) => item.key === suggestion.mappingKey,
      )!;
      if (definition.requirement !== "conditional") {
        this.conflict("accounting_setup_mandatory_mapping_not_applicable_prohibited");
      }
      return this.recordDecision(suggestionId, input, {}, idempotencyKey);
    }
    if (input.decision === "accept" || input.decision === "change") {
      const selectedId =
        input.decision === "change" ? input.accountId : suggestion.suggestedAccount?.id;
      if (selectedId === undefined) {
        this.conflict("accounting_setup_suggestion_conflict", "No compatible Account was selected");
      }
      const definition = accountingMandatoryMappings.find(
        (item) => item.key === suggestion.mappingKey,
      )!;
      const source = await this.source(this.database);
      const account = source.accounts.find((item) => item.id === selectedId);
      if (account === undefined) this.conflict("accounting_setup_company_mismatch");
      const compatibility = this.compatibility(definition, account);
      if (!compatibility.compatible) {
        this.conflict(
          compatibility.errors.includes("summary_account")
            ? "accounting_setup_summary_account_invalid"
            : compatibility.errors.includes("inactive_account")
              ? "accounting_setup_account_inactive"
              : "accounting_setup_account_incompatible",
          compatibility.errors.join(", "),
        );
      }
      const mapping = await this.management.createMapping(
        {
          mappingKey: definition.key,
          [definition.field]: selectedId,
          effectiveFrom: input.effectiveFrom,
          ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
        },
        idempotencyKey === undefined ? undefined : `${idempotencyKey}:mapping`,
      );
      return this.recordDecision(suggestionId, input, { mapping }, idempotencyKey);
    }
    return this.recordDecision(suggestionId, input, {}, idempotencyKey);
  }

  private async recordDecision(
    suggestionId: string,
    input: AccountingMappingDecisionDto,
    extra: object,
    idempotencyKey?: string,
  ) {
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<Record<string, unknown>>(
        transaction,
        {
          idempotencyKey,
          operation: "accounting.setup.mapping-suggestion.decision",
          payload: { suggestionId, ...input },
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { companyId } = this.support.context();
      const statusByDecision = {
        accept: "accepted",
        change: "changed",
        reject: "rejected",
        unresolved: "unresolved",
        not_applicable: "not_applicable",
      } as const;
      const decisionStatus = statusByDecision[input.decision];
      const response = {
        suggestionId,
        status: decisionStatus,
        reason: input.reason,
        ...extra,
      };
      await this.support.audit(transaction, {
        action: `accounting.setup.mapping_suggestion.${decisionStatus}`,
        after: response,
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: suggestionId,
        subjectType: "accounting_mapping_suggestion",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.setup.mapping-suggestion.decision",
        resourceId: companyId,
        resourceType: "accounting_setup",
        responseBody: response,
      });
      return response;
    });
  }

  private async openingProtection(database: Kysely<DatabaseSchema>, effectiveDate: string) {
    const { companyId } = this.support.context();
    const result = await sql<{
      cashBankOpenings: string;
      openingBatches: string;
      operationalBalances: string;
      priorPostedJournals: string;
      priorAccountingEvents: string;
    }>`
      select
        (select count(*)::text from opening_balance_batches
          where company_id=${companyId}::uuid and status in('posted','reversed')) as "openingBatches",
        (select count(*)::text from journal_entries
          where company_id=${companyId}::uuid and status in('posted','reversed')
            and business_date<${effectiveDate}::date) as "priorPostedJournals",
        (select count(*)::text from cash_bank_movements
          where company_id=${companyId}::uuid and movement_type='opening_balance'
            and status in('confirmed','reversed')) as "cashBankOpenings",
        (select count(*)::text from accounting_events
          where company_id=${companyId}::uuid and effective_accounting_date<${effectiveDate}::date
            and processing_status in('posted','validated','processing','retry_pending')) as "priorAccountingEvents",
        (
          (select count(*) from trader_receivables
            where company_id=${companyId}::uuid and business_date<${effectiveDate}::date
              and outstanding_amount>0 and status not in('cancelled','reversed'))
          +(select count(*) from payroll_entries e join payroll_periods p
              on p.id=e.payroll_period_id and p.company_id=e.company_id
            where e.company_id=${companyId}::uuid and p.period_end<${effectiveDate}::date
              and e.outstanding_amount>0 and e.status<>'reversed')
          +(select count(*) from outsourced_driver_fee_accruals
            where company_id=${companyId}::uuid and accrual_business_date<${effectiveDate}::date
              and (outstanding_amount>0 or recovery_amount>0) and status<>'reversed')
          +(select count(*) from general_expenses
            where company_id=${companyId}::uuid and accounting_date<${effectiveDate}::date
              and outstanding_amount>0 and status not in('cancelled','reversed','rejected'))
          +(select count(*) from orders
            where company_id=${companyId}::uuid and delivered_at is not null
              and delivered_at<${effectiveDate}::date)
        )::text as "operationalBalances"
    `.execute(database);
    const counts = result.rows[0]!;
    const blockers = [
      ...(counts.openingBatches === "0" ? [] : ["posted_opening_balance_exists"]),
      ...(counts.priorPostedJournals === "0" ? [] : ["prior_posted_ledger_exists"]),
      ...(counts.cashBankOpenings === "0" ? [] : ["cash_bank_opening_exists"]),
      ...(counts.priorAccountingEvents === "0"
        ? []
        : ["prior_operational_accounting_events_exist"]),
      ...(counts.operationalBalances === "0" ? [] : ["legacy_operational_balances_exist"]),
    ];
    return { blockers, counts, safe: blockers.length === 0 };
  }

  public async zeroOpeningStatus(effectiveDate = currentDate()) {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    this.validateDate(effectiveDate);
    const { companyId } = this.support.context();
    const confirmation = await sql<Record<string, unknown>>`
      select z.id,z.effective_date::text as "effectiveDate",
             z.fiscal_year_id as "fiscalYearId",z.fiscal_period_id as "fiscalPeriodId",
             z.reason,z.confirmed_at as "confirmedAt",z.revoked_at as "revokedAt",
             z.revocation_reason as "revocationReason",z.version::text as version
        from accounting_zero_opening_confirmations z
       where z.company_id=${companyId}::uuid
       order by z.confirmed_at desc limit 1
    `.execute(this.database);
    const protection = await this.openingProtection(this.database, effectiveDate);
    return {
      status:
        confirmation.rows[0] === undefined
          ? protection.safe
            ? "no_opening_balance"
            : "blocking_balance_indicators"
          : confirmation.rows[0].revokedAt === null
            ? protection.safe
              ? "zero_opening_confirmed"
              : "zero_opening_confirmation_invalidated"
            : "zero_opening_revoked",
      confirmation: confirmation.rows[0] ?? null,
      ...protection,
    };
  }

  public async confirmZeroOpening(input: AccountingZeroOpeningDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    if (!input.administratorAcknowledged) {
      this.conflict("accounting_setup_zero_opening_acknowledgement_required");
    }
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.setup.zero-opening.confirm",
        payload: input,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      await sql`select pg_advisory_xact_lock(hashtextextended(
        'accounting_zero_opening:'||${companyId}::text,0))`.execute(transaction);
      const active = await sql<{ exists: boolean }>`
        select exists(select 1 from accounting_zero_opening_confirmations
          where company_id=${companyId}::uuid and revoked_at is null) as exists
      `.execute(transaction);
      if (active.rows[0]?.exists) {
        this.conflict("accounting_setup_zero_opening_conflict");
      }
      const protection = await this.openingProtection(transaction, input.effectiveDate);
      if (!protection.safe) {
        this.conflict("accounting_setup_zero_opening_not_allowed", protection.blockers.join(", "));
      }
      const period = await sql<{ valid: boolean }>`
        select exists(
          select 1 from accounting_periods p join fiscal_years y
            on y.id=p.fiscal_year_id and y.company_id=p.company_id
           where p.company_id=${companyId}::uuid and p.id=${input.fiscalPeriodId}::uuid
             and y.id=${input.fiscalYearId}::uuid
             and ${input.effectiveDate}::date between p.period_start and p.period_end
             and p.status in('open','reopened') and y.status in('open','reopened')
        ) as valid
      `.execute(transaction);
      if (!period.rows[0]?.valid) this.conflict("accounting_setup_zero_opening_period_invalid");
      const inserted = await sql<Record<string, unknown>>`
        insert into accounting_zero_opening_confirmations(
          company_id,effective_date,fiscal_year_id,fiscal_period_id,
          confirmation_statement,reason,administrator_acknowledged,confirmed_by_account_id
        ) values(
          ${companyId}::uuid,${input.effectiveDate}::date,${input.fiscalYearId}::uuid,
          ${input.fiscalPeriodId}::uuid,${input.confirmationStatement.trim()},
          ${input.reason.trim()},true,${actorId}::uuid
        )
        returning id,effective_date::text as "effectiveDate",confirmed_at as "confirmedAt",
                  version::text as version
      `.execute(transaction);
      const response = inserted.rows[0]!;
      await this.support.audit(transaction, {
        action: "accounting.setup.zero_opening.confirmed",
        after: { ...response, reason: input.reason },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: String(response.id),
        subjectType: "accounting_zero_opening",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.setup.zero-opening.confirm",
        resourceId: String(response.id),
        resourceType: "accounting_zero_opening",
        responseBody: response,
      });
      return response;
    });
  }

  public async revokeZeroOpening(reason: string, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.setup.zero-opening.revoke",
        payload: { reason: reason.trim() },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      const updated = await sql<Record<string, unknown>>`
        update accounting_zero_opening_confirmations
           set revoked_by_account_id=${actorId}::uuid,revoked_at=now(),
               revocation_reason=${reason.trim()},version=version+1
         where company_id=${companyId}::uuid and revoked_at is null
         returning id,revoked_at as "revokedAt",version::text as version
      `.execute(transaction);
      if (updated.rows[0] === undefined) this.conflict("accounting_setup_zero_opening_not_found");
      const response = updated.rows[0]!;
      await this.support.audit(transaction, {
        action: "accounting.setup.zero_opening.revoked",
        after: { ...response, reason },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: String(response.id),
        subjectType: "accounting_zero_opening",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.setup.zero-opening.revoke",
        resourceId: String(response.id),
        resourceType: "accounting_zero_opening",
        responseBody: response,
      });
      return response;
    });
  }

  public async dashboardActions() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const [counts, mappingIssues] = await Promise.all([
      sql<Record<string, string>>`
        select
          (select count(*)::text from journal_entries where company_id=${companyId}::uuid and status='balanced') as "journalsAwaitingApproval",
          (select count(*)::text from journal_entries where company_id=${companyId}::uuid and status='approved') as "journalsAwaitingPosting",
          (select count(*)::text from journal_entries where company_id=${companyId}::uuid and status='draft' and total_debit<>total_credit) as "unbalancedDraftJournals",
          (select count(*)::text from accounting_events where company_id=${companyId}::uuid and processing_status='failed') as "failedAccountingEvents",
          (select count(*)::text from accounting_events where company_id=${companyId}::uuid and processing_status='blocked_configuration') as "configurationBlockedEvents",
          (select count(*)::text from accounting_events where company_id=${companyId}::uuid and processing_status='retry_pending') as "periodBlockedEvents",
          (select count(*)::text from general_expenses where company_id=${companyId}::uuid and status='submitted') as "expensesAwaitingApproval",
          (select count(*)::text from general_expenses where company_id=${companyId}::uuid and status in('approved','partially_paid')) as "outstandingExpenses",
          (select count(*)::text from cash_bank_movements where company_id=${companyId}::uuid and status='draft') as "draftCashBankMovements",
          (select min(created_at)::text from (
            select created_at from journal_entries where company_id=${companyId}::uuid and status in('draft','balanced','approved')
            union all select created_at from accounting_events where company_id=${companyId}::uuid
              and processing_status in('failed','blocked_configuration','retry_pending')
            union all select created_at from general_expenses where company_id=${companyId}::uuid
              and status in('submitted','approved','partially_paid')
          ) unresolved) as "oldestUnresolved"
      `.execute(this.database),
      this.mappingIssues(),
    ]);
    const row = counts.rows[0] ?? {};
    const items = [
      ["journalsAwaitingApproval", row.journalsAwaitingApproval, "warning", "/accounting/journals"],
      ["journalsAwaitingPosting", row.journalsAwaitingPosting, "warning", "/accounting/journals"],
      ["unbalancedDraftJournals", row.unbalancedDraftJournals, "critical", "/accounting/journals"],
      ["failedAccountingEvents", row.failedAccountingEvents, "critical", "/accounting/events"],
      [
        "configurationBlockedEvents",
        row.configurationBlockedEvents,
        "critical",
        "/accounting/events",
      ],
      ["periodBlockedEvents", row.periodBlockedEvents, "critical", "/accounting/events"],
      [
        "missingMandatoryMappings",
        String(mappingIssues.counts.missing),
        "critical",
        "/accounting/setup",
      ],
      ["invalidMappings", String(mappingIssues.counts.invalid), "critical", "/accounting/setup"],
      [
        "inactiveMappedAccounts",
        String(mappingIssues.counts.inactive),
        "critical",
        "/accounting/setup",
      ],
      ["mappingGaps", String(mappingIssues.counts.gaps), "warning", "/accounting/setup"],
      ["mappingOverlaps", String(mappingIssues.counts.overlaps), "critical", "/accounting/setup"],
      ["expensesAwaitingApproval", row.expensesAwaitingApproval, "warning", "/accounting/expenses"],
      ["outstandingExpenses", row.outstandingExpenses, "warning", "/accounting/expenses"],
      [
        "draftCashBankMovements",
        row.draftCashBankMovements,
        "warning",
        "/accounting/cash-bank-movements",
      ],
      ["reconciliationMismatches", null, "warning", "/accounting/reconciliation"],
      ["reversalMismatches", null, "warning", "/accounting/reconciliation"],
      ["trialBalanceDifference", null, "critical", "/accounting/reports/trial-balance"],
      ["balanceSheetDifference", null, "critical", "/accounting/reports/balance-sheet"],
    ].map(([key, count, severity, target]) => ({ key, count: count ?? null, severity, target }));
    return {
      items,
      partialAvailability: [
        "full_bank_reconciliation_unavailable",
        "standalone_reversal_mismatch_register_unavailable",
      ],
      oldestUnresolvedItem:
        row.oldestUnresolved === undefined || row.oldestUnresolved === null
          ? null
          : {
              severity: "warning",
              target: "/accounting",
              timestamp: row.oldestUnresolved,
            },
      evaluatedAt: new Date().toISOString(),
    };
  }

  public async financialSnapshot() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, string | null>>`
      with ledger as (
        select a.account_class,a.account_type,
               sum(l.debit-l.credit) as debit_balance,
               sum(l.credit-l.debit) as credit_balance
          from journal_entries j join journal_lines l
            on l.journal_entry_id=j.id and l.company_id=j.company_id
          join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
         where j.company_id=${companyId}::uuid and j.status in('posted','reversed')
         group by a.account_class,a.account_type
      ), current_period as (
        select p.period_start,p.period_end,p.status
          from accounting_periods p
         where p.company_id=${companyId}::uuid
           and (now() at time zone 'Asia/Dubai')::date between p.period_start and p.period_end
         order by p.period_start desc limit 1
      ), period_ledger as (
        select a.account_type,sum(l.credit-l.debit) as credit_balance
          from journal_entries j join journal_lines l
            on l.journal_entry_id=j.id and l.company_id=j.company_id
          join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
          join current_period p on j.business_date between p.period_start and p.period_end
         where j.company_id=${companyId}::uuid and j.status in('posted','reversed')
         group by a.account_type
      )
      select
        case when exists(select 1 from chart_of_accounts where company_id=${companyId}::uuid and account_class='cash' and is_active)
          then coalesce((select sum(debit_balance) from ledger where account_class='cash'),0)::text end as "cashBalance",
        case when exists(select 1 from chart_of_accounts where company_id=${companyId}::uuid and account_class='bank' and is_active)
          then coalesce((select sum(debit_balance) from ledger where account_class='bank'),0)::text end as "bankBalance",
        case when exists(select 1 from chart_of_accounts where company_id=${companyId}::uuid and account_class='accounts_receivable' and is_active)
          and exists(select 1 from account_mappings where company_id=${companyId}::uuid
            and mapping_key='order_cod_receivable' and is_active
            and effective_from<=(now() at time zone 'Asia/Dubai')::date
            and coalesce(effective_to,'infinity'::date)>=(now() at time zone 'Asia/Dubai')::date)
          then coalesce((select sum(debit_balance) from ledger where account_class='accounts_receivable'),0)::text end as "accountsReceivable",
        case when exists(select 1 from chart_of_accounts where company_id=${companyId}::uuid and account_class='trader_payable' and is_active)
          and exists(select 1 from account_mappings where company_id=${companyId}::uuid
            and mapping_key='trader_payable' and is_active
            and effective_from<=(now() at time zone 'Asia/Dubai')::date
            and coalesce(effective_to,'infinity'::date)>=(now() at time zone 'Asia/Dubai')::date)
          then coalesce((select sum(credit_balance) from ledger where account_class='trader_payable'),0)::text end as "traderPayables",
        case when exists(select 1 from chart_of_accounts where company_id=${companyId}::uuid and account_class='accounts_payable' and is_active)
          and exists(select 1 from account_mappings where company_id=${companyId}::uuid
            and mapping_key='general_expense_payable' and is_active
            and effective_from<=(now() at time zone 'Asia/Dubai')::date
            and coalesce(effective_to,'infinity'::date)>=(now() at time zone 'Asia/Dubai')::date)
          then coalesce((select sum(credit_balance) from ledger where account_class='accounts_payable'),0)::text end as "generalExpensePayables",
        case when exists(select 1 from chart_of_accounts where company_id=${companyId}::uuid and account_class='payroll_payable' and is_active)
          and exists(select 1 from account_mappings where company_id=${companyId}::uuid
            and mapping_key='employee_payroll_payable' and is_active
            and effective_from<=(now() at time zone 'Asia/Dubai')::date
            and coalesce(effective_to,'infinity'::date)>=(now() at time zone 'Asia/Dubai')::date)
          then coalesce((select sum(credit_balance) from ledger where account_class='payroll_payable'),0)::text end as "payrollPayables",
        case when exists(select 1 from current_period)
          then coalesce((select credit_balance from period_ledger where account_type='revenue'),0)::text end as "currentPeriodRevenue",
        case when exists(select 1 from current_period)
          then coalesce(-(select credit_balance from period_ledger where account_type='expense'),0)::text end as "currentPeriodExpenses",
        case when exists(select 1 from current_period)
          then (coalesce((select credit_balance from period_ledger where account_type='revenue'),0)
            +coalesce((select credit_balance from period_ledger where account_type='expense'),0))::text end as "currentProfitOrLoss",
        coalesce((select sum(debit_balance) from ledger),0)::text as "trialBalanceDifference",
        (select status from current_period) as "currentPeriodStatus",
        (select max(business_date)::text from journal_entries where company_id=${companyId}::uuid and status in('posted','reversed')) as "latestPostedJournalDate"
    `.execute(this.database);
    const data = result.rows[0] ?? {};
    return {
      ...data,
      provisional: data.currentPeriodStatus === "open" || data.currentPeriodStatus === "reopened",
      snapshotTime: new Date().toISOString(),
      warnings: Object.values(data).some((value) => value === null)
        ? ["unavailable_values_require_account_classification"]
        : [],
    };
  }

  public async recentActivity(limit = 30) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const bounded = Math.min(50, Math.max(1, limit));
    const result = await sql<Record<string, unknown>>`
      select activity_type as "activityType",reference,description,amount,status,
             actor,occurred_at as timestamp,target
        from (
          select 'journal'::text activity_type,j.journal_number reference,j.description,
                 greatest(j.total_debit,j.total_credit)::text amount,j.status,
                 coalesce(a.username,'System') actor,j.updated_at occurred_at,
                 '/accounting/journals'::text target
            from journal_entries j left join accounts a
              on a.id=coalesce(j.posted_by_account_id,j.approved_by_account_id,j.created_by_account_id)
             and a.company_id=j.company_id
           where j.company_id=${companyId}::uuid
          union all
          select 'accounting_event',e.source_reference,e.event_type,null,e.processing_status,
                 'System',coalesce(e.processed_at,e.failed_at,e.reprocessed_at,e.created_at),'/accounting/events'
            from accounting_events e where e.company_id=${companyId}::uuid
          union all
          select 'configuration',null,a.action,null,'completed',
                 coalesce(actor.username,'System'),a.occurred_at,'/accounting/setup'
            from audit_events a left join accounts actor on actor.id=a.actor_account_id
           where a.company_id=${companyId}::uuid
             and a.action like 'accounting.%'
        ) activity
       order by occurred_at desc limit ${bounded}
    `.execute(this.database);
    return { limit: bounded, items: result.rows };
  }

  private async activationState(database: Kysely<DatabaseSchema>, activationDate: string) {
    const { companyId } = this.support.context();
    const [{ accounts, mappings }, configuration, period, links, opening] = await Promise.all([
      this.source(database),
      sql<{ accountingEnabled: boolean; baseCurrency: string }>`
        select accounting_enabled as "accountingEnabled",base_currency as "baseCurrency"
          from accounting_configurations where company_id=${companyId}::uuid
      `.execute(database),
      sql<{ available: boolean }>`
        select exists(select 1 from accounting_periods p join fiscal_years y
          on y.id=p.fiscal_year_id and y.company_id=p.company_id
          where p.company_id=${companyId}::uuid
            and ${activationDate}::date between p.period_start and p.period_end
            and p.status in('open','reopened') and y.status in('open','reopened')) as available
      `.execute(database),
      sql<{ invalid: string; total: string }>`
        select count(*)::text total,count(*) filter(where a.id is null or not a.is_active
          or not a.is_posting_account)::text invalid from (
          select company_id,linked_gl_account_id from company_cash_accounts where company_id=${companyId}::uuid and is_active
          union all select company_id,linked_gl_account_id from company_bank_accounts where company_id=${companyId}::uuid and is_active
        ) f left join chart_of_accounts a on a.id=f.linked_gl_account_id and a.company_id=f.company_id
      `.execute(database),
      sql<{ posted: boolean; zeroConfirmed: boolean }>`
        select
          exists(select 1 from opening_balance_batches where company_id=${companyId}::uuid and status='posted') as posted,
          exists(select 1 from accounting_zero_opening_confirmations
            where company_id=${companyId}::uuid and revoked_at is null
              and effective_date<=${activationDate}::date) as "zeroConfirmed"
      `.execute(database),
    ]);
    const mandatory = accountingMandatoryMappings.filter(
      (item) => item.requirement === "mandatory",
    );
    const invalidMappings: string[] = [];
    for (const definition of mandatory) {
      const mapping = mappings.find(
        (item) =>
          item.mappingKey === definition.key &&
          item.isActive &&
          item.effectiveFrom <= activationDate &&
          (item.effectiveTo === null || item.effectiveTo >= activationDate),
      );
      const account = accounts.find((item) => item.id === mappedAccountId(definition, mapping));
      if (account === undefined || !this.compatibility(definition, account).compatible) {
        invalidMappings.push(definition.key);
      }
    }
    const config = configuration.rows[0];
    const link = links.rows[0] ?? { total: "0", invalid: "0" };
    const openingRow = opening.rows[0] ?? { posted: false, zeroConfirmed: false };
    const blockers = [
      ...(config === undefined ? ["configuration_missing"] : []),
      ...(config?.baseCurrency === "AED" ? [] : ["base_currency_not_aed"]),
      ...(accounts.length > 0 ? [] : ["chart_of_accounts_missing"]),
      ...(invalidMappings.length === 0 ? [] : ["mandatory_mappings_incomplete"]),
      ...(period.rows[0]?.available ? [] : ["open_fiscal_period_missing"]),
      ...(link.total !== "0" && link.invalid === "0" ? [] : ["cash_bank_gl_links_incomplete"]),
      ...(openingRow.posted || openingRow.zeroConfirmed
        ? []
        : ["opening_balance_decision_missing"]),
    ];
    const completed = 7 - blockers.length;
    return {
      manualAccountingEnabled: config?.accountingEnabled ?? false,
      activationEligible: blockers.length === 0,
      configurationPercentage: Math.max(0, Math.round((completed / 7) * 100)),
      chartOfAccountsStatus: accounts.length > 0 ? "complete" : "incomplete",
      mappingStatus: invalidMappings.length === 0 ? "complete" : "incomplete",
      invalidMandatoryMappings: invalidMappings,
      fiscalPeriodStatus: period.rows[0]?.available ? "open" : "missing_or_closed",
      cashBankLinkingStatus: link.total !== "0" && link.invalid === "0" ? "complete" : "incomplete",
      openingBalanceStatus: openingRow.posted
        ? "posted"
        : openingRow.zeroConfirmed
          ? "zero_confirmed"
          : "missing",
      criticalBlockers: blockers,
      warnings: ["historical_backfill_not_run", "automatic_posting_remains_disabled"],
      requiredAcknowledgements: ["historical_backfill_not_run", "controlled_testing_required"],
      proposedActivationDate: activationDate,
      historicalBackfillStatus: "not_run",
      automaticPostingStatus: "unchanged",
      recommendedNextSteps:
        blockers.length === 0
          ? ["activate_manual_accounting", "create_controlled_test_journal"]
          : blockers,
      evaluatedAt: new Date().toISOString(),
    };
  }

  public async activationPreview(input: AccountingActivationPreviewDto) {
    this.support.assertPermission("accounting.configuration.manage");
    this.validateDate(input.activationDate);
    const result = await this.activationState(this.database, input.activationDate);
    const { companyId } = this.support.context();
    await this.support.audit(this.database, {
      action: "accounting.setup.activation_preview.generated",
      after: {
        activationDate: input.activationDate,
        activationEligible: result.activationEligible,
        blockerCodes: result.criticalBlockers,
        warningCodes: result.warnings,
      },
      correlationId: randomUUID(),
      subjectId: companyId,
      subjectType: "accounting_configuration",
    });
    return result;
  }

  public async configurationCompleteness() {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    const evaluatedOn = currentDate();
    const [state, areaState, mappingIssues] = await Promise.all([
      this.activationState(this.database, evaluatedOn),
      this.areaReadiness(),
      this.mappingIssues(evaluatedOn),
    ]);
    const steps = [
      {
        key: "chart",
        complete: state.chartOfAccountsStatus === "complete",
        target: "/accounting/chart-of-accounts",
      },
      {
        key: "accountsClassified",
        complete: state.chartOfAccountsStatus === "complete",
        target: "/accounting/chart-of-accounts",
      },
      {
        key: "requiredMappings",
        complete: state.mappingStatus === "complete",
        target: "/accounting/setup",
      },
      {
        key: "fiscalYear",
        complete: state.fiscalPeriodStatus === "open",
        target: "/accounting/fiscal-years",
      },
      {
        key: "openFiscalPeriod",
        complete: state.fiscalPeriodStatus === "open",
        target: "/accounting/fiscal-periods",
      },
      {
        key: "cashAndBankLinked",
        complete: state.cashBankLinkingStatus === "complete",
        target: "/accounting/cash-accounts",
      },
      {
        key: "openingBalances",
        complete: state.openingBalanceStatus !== "missing",
        target: "/accounting/opening-balances",
      },
      {
        key: "manualAccounting",
        complete: state.manualAccountingEnabled,
        target: "/accounting/setup",
      },
    ];
    return {
      ready: state.activationEligible,
      status: state.activationEligible
        ? state.warnings.length === 0
          ? "ready"
          : "ready_with_warnings"
        : "not_ready",
      completionPercentage: state.configurationPercentage,
      completedSteps: steps.filter((step) => step.complete).map((step) => step.key),
      incompleteSteps: steps.filter((step) => !step.complete),
      blockers: state.criticalBlockers.map((code) => ({
        code,
        message: code.replaceAll("_", " "),
        target: steps.find((step) => !step.complete)?.target ?? "/accounting/setup",
      })),
      warnings: state.warnings,
      notApplicable: [],
      mappingIssues: mappingIssues.counts,
      manualAccountingEligible: state.activationEligible,
      areaReadiness: areaState.areas,
      evaluatedAt: state.evaluatedAt,
    };
  }

  public async activateManualAccounting(input: AccountingActivationDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    if (!input.confirmation) this.conflict("accounting_setup_activation_confirmation_required");
    const result = await this.transactions.execute(async (transaction) => {
      const { actorId, companyId } = this.support.context();
      await sql`select 1 from accounting_configurations where company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      await sql`select pg_advisory_xact_lock(hashtextextended(
        'accounting_account_configuration:'||${companyId}::text,0))`.execute(transaction);
      const readiness = await this.activationState(transaction, input.activationDate);
      if (readiness.manualAccountingEnabled) {
        return {
          accountingEnabled: true,
          alreadyEnabled: true,
          automaticPostingStatus: "unchanged",
          historicalBackfillExecuted: false,
          journalsCreated: false,
        };
      }
      if (!readiness.activationEligible) {
        const blocked = {
          __activationBlocked: true as const,
          blockerCodes: readiness.criticalBlockers,
        };
        await this.support.audit(transaction, {
          action: "accounting.setup.manual_accounting.activation_blocked",
          after: blocked,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: companyId,
          subjectType: "accounting_configuration",
        });
        return blocked;
      }
      const acknowledged = new Set(input.acknowledgedWarningCodes ?? []);
      const missing = readiness.requiredAcknowledgements.filter((item) => !acknowledged.has(item));
      if (missing.length > 0) {
        this.conflict("accounting_setup_warning_acknowledgement_required", missing.join(", "));
      }
      const reservation = await this.support.reserveIdempotency<Record<string, unknown>>(
        transaction,
        {
          idempotencyKey,
          operation: "accounting.setup.activate-manual-accounting",
          payload: input,
        },
      );
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const updated = await sql<Record<string, unknown>>`
        update accounting_configurations set accounting_enabled=true,
          automatic_posting_enabled=false,automatic_posting_areas=array[]::text[],
          manual_accounting_activation_date=${input.activationDate}::date,
          manual_accounting_enabled_by_account_id=${actorId}::uuid,
          manual_accounting_enabled_at=now(),updated_by_account_id=${actorId}::uuid,
          updated_at=now(),version=version+1
        where company_id=${companyId}::uuid
        returning accounting_enabled as "accountingEnabled",
          automatic_posting_enabled as "automaticPostingEnabled",
          manual_accounting_activation_date::text as "activationDate",
          manual_accounting_enabled_at as "activatedAt",version::text as version
      `.execute(transaction);
      if (updated.rows[0] === undefined) this.conflict("accounting_setup_activation_stale");
      const response = {
        ...updated.rows[0],
        message: "Manual Accounting is enabled and ready for controlled testing.",
        historicalBackfillExecuted: false,
        journalsCreated: false,
        nextTestingSteps: [
          "create_test_manual_journal",
          "approve_and_post_journal",
          "verify_trial_balance",
          "verify_opening_balance_status",
          "test_general_expense",
          "test_expense_payment",
          "test_cash_bank_movement",
          "review_accounting_events",
          "review_reconciliation",
          "enable_one_automatic_posting_area",
          "verify_generated_journal",
          "test_reversal",
        ],
      };
      await this.support.audit(transaction, {
        action: "accounting.setup.activation_warnings.acknowledged",
        after: { warningCodes: [...acknowledged] },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: companyId,
        subjectType: "accounting_configuration",
      });
      await this.support.audit(transaction, {
        action: "accounting.setup.manual_accounting.activated",
        after: {
          ...response,
          acknowledgedWarningCodes: [...acknowledged],
        },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: companyId,
        subjectType: "accounting_configuration",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.setup.activate-manual-accounting",
        resourceId: companyId,
        resourceType: "accounting_configuration",
        responseBody: response,
      });
      return response;
    });
    if ("__activationBlocked" in result && result.__activationBlocked === true) {
      const blockerCodes = Array.isArray(result.blockerCodes)
        ? result.blockerCodes.map(String)
        : ["readiness_changed"];
      this.conflict("accounting_setup_activation_blocked", blockerCodes.join(", "));
    }
    return result;
  }

  public async areaReadiness() {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    const { companyId } = this.support.context();
    const readiness = await this.automaticPosting.readiness();
    const history = await sql<{
      area: string;
      failedCount: string;
      lastSuccessfulPosting: string | null;
      waitingCount: string;
    }>`
      select operational_area as area,
        count(*) filter(where processing_status='failed')::text as "failedCount",
        count(*) filter(where processing_status
          in('received','retry_pending','processing'))::text as "waitingCount",
        (max(processed_at) filter(where processing_status='posted'))::text as "lastSuccessfulPosting"
      from accounting_events
      where company_id=${companyId}::uuid and operational_area is not null
      group by operational_area
    `.execute(this.database);
    // Events still awaiting posting, so an operator can see exactly what is
    // queued for an area before enabling it. Read-only: nothing is claimed,
    // processed, or mutated here.
    const waiting = await sql<{
      area: string;
      attemptCount: number;
      eventType: string;
      hasJournal: boolean;
      processingStatus: string;
      sourceReference: string | null;
    }>`
      select operational_area as area,event_type as "eventType",
             source_reference as "sourceReference",processing_status as "processingStatus",
             attempt_count as "attemptCount",(journal_id is not null) as "hasJournal"
        from accounting_events
       where company_id=${companyId}::uuid and operational_area is not null
         and processing_status in('received','retry_pending','processing')
       order by created_at,id
       limit 100
    `.execute(this.database);
    return {
      ...readiness,
      areas: readiness.areas.map((area) => ({
        ...area,
        failedEventCount: history.rows.find((item) => item.area === area.area)?.failedCount ?? "0",
        lastSuccessfulPosting:
          history.rows.find((item) => item.area === area.area)?.lastSuccessfulPosting ?? null,
        recommendedTestAction: `test_${area.area}_with_one_new_transaction`,
        waitingEventCount: history.rows.find((item) => item.area === area.area)?.waitingCount ?? "0",
        waitingEvents: waiting.rows
          .filter((item) => item.area === area.area)
          .map(({ area: _area, ...event }) => event),
      })),
    };
  }

  public async changeArea(
    input: AccountingAreaChangeDto,
    enable: boolean,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    if (!input.confirmation) this.conflict("accounting_setup_area_confirmation_required");
    if (enable) {
      const readiness = await this.areaReadiness();
      const selected = readiness.areas.find((area) => area.area === input.area);
      if (selected?.ready !== true) {
        this.conflict("accounting_setup_area_not_ready", "The selected posting area is not ready");
      }
    }
    return this.automaticPosting.setArea(input.area, enable, input.reason, idempotencyKey);
  }
}
