import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { sql } from "kysely";
import type { Kysely } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { cashBankMovementTypes } from "./accounting.constants.js";
import type {
  CashBankBackfillPreviewDto,
  CashBankListQueryDto,
  CashBankMovementPreviewQueryDto,
} from "./cash-bank.dto.js";
import { GeneralExpenseQueryService } from "./general-expense-query.service.js";

/**
 * The account shape each Movement Type requires, mirroring
 * `CashBankManagementService.validMovementStructure` exactly. The form uses it
 * to show ONLY the relevant From/To fields, so the two can never disagree.
 *
 * `opening_balance` is deliberately absent: it is owned by the Opening Balance
 * workflow and `enqueueEvent` rejects it, so offering it here would be a dead
 * choice.
 */
const movementShapes: Readonly<
  Record<
    string,
    {
      readonly classification: "deposit" | "transfer" | "withdrawal";
      readonly destination: "bank" | "cash" | null;
      readonly source: "bank" | "cash" | null;
    }
  >
> = {
  bank_deposit: { classification: "deposit", destination: "bank", source: null },
  bank_to_bank_transfer: { classification: "transfer", destination: "bank", source: "bank" },
  bank_to_cash_transfer: { classification: "transfer", destination: "cash", source: "bank" },
  bank_withdrawal: { classification: "withdrawal", destination: null, source: "bank" },
  cash_deposit: { classification: "deposit", destination: "cash", source: null },
  cash_to_bank_transfer: { classification: "transfer", destination: "bank", source: "cash" },
  cash_to_cash_transfer: { classification: "transfer", destination: "cash", source: "cash" },
  cash_withdrawal: { classification: "withdrawal", destination: null, source: "cash" },
};

@Injectable()
export class CashBankQueryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    // Reused for its Company-scoped, effective-dated mapping resolution, which
    // reports an unresolved mapping as data instead of throwing. The method is
    // generic — it takes the Company, key, date and intent — despite living on
    // the General Expense query service.
    @Inject(GeneralExpenseQueryService)
    private readonly mappings: GeneralExpenseQueryService,
  ) {}

  public async list(input: CashBankListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 50;
    const search = input.search?.trim() || null;
    // Sorting is chosen from a closed list validated by the DTO, so the
    // resolved expression is a literal and never User text.
    const sortColumns: Readonly<Record<string, string>> = {
      accountingDate: "m.accounting_date",
      amount: "m.amount",
      movementDate: "m.movement_date",
      movementNumber: "m.movement_number",
      movementType: "m.movement_type",
    };
    const sort = sortColumns[input.sortBy ?? "accountingDate"] ?? "m.accounting_date";
    const direction = input.sortDirection === "asc" ? "asc" : "desc";
    const result = await sql<Record<string, unknown>>`
      select m.id,m.movement_number as "movementNumber",m.movement_type as "movementType",
             sc.cash_account_code as "sourceCashAccountCode",
             sb.bank_account_code as "sourceBankAccountCode",
             dc.cash_account_code as "destinationCashAccountCode",
             db.bank_account_code as "destinationBankAccountCode",
             e.processing_status as "accountingStatus",
             m.reversal_of_movement_id as "reversalOfMovementId",
             m.reversed_by_movement_id as "reversedByMovementId",
             m.movement_date::text as "movementDate",m.accounting_date::text as "accountingDate",
             m.amount::text,m.fee_amount::text as "feeAmount",m.currency,m.status,
             m.reference_number as "referenceNumber",m.external_reference as "externalReference",
             m.description,m.source_cash_account_id as "sourceCashAccountId",
             sc.cash_account_name as "sourceCashAccountName",
             m.source_bank_account_id as "sourceBankAccountId",
             sb.account_name as "sourceBankAccountName",
             m.destination_cash_account_id as "destinationCashAccountId",
             dc.cash_account_name as "destinationCashAccountName",
             m.destination_bank_account_id as "destinationBankAccountId",
             db.account_name as "destinationBankAccountName",
             m.accounting_event_id as "accountingEventId",j.id as "journalId",
             j.journal_number as "journalNumber",m.created_at as "createdAt",
             count(*) over()::text as "totalCount"
        from cash_bank_movements m
        left join company_cash_accounts sc on sc.id=m.source_cash_account_id and sc.company_id=m.company_id
        left join company_bank_accounts sb on sb.id=m.source_bank_account_id and sb.company_id=m.company_id
        left join company_cash_accounts dc on dc.id=m.destination_cash_account_id and dc.company_id=m.company_id
        left join company_bank_accounts db on db.id=m.destination_bank_account_id and db.company_id=m.company_id
        left join accounting_events e on e.id=m.accounting_event_id and e.company_id=m.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
       where m.company_id=${companyId}::uuid
         and (${input.movementType ?? null}::text is null or m.movement_type=${input.movementType ?? null})
         and (${input.status ?? null}::text is null or m.status=${input.status ?? null})
         and (${input.dateFrom ?? null}::date is null or m.accounting_date>=${input.dateFrom ?? null}::date)
         and (${input.dateTo ?? null}::date is null or m.accounting_date<=${input.dateTo ?? null}::date)
         and (${input.cashAccountId ?? null}::uuid is null or
              ${input.cashAccountId ?? null}::uuid in(m.source_cash_account_id,m.destination_cash_account_id))
         and (${input.bankAccountId ?? null}::uuid is null or
              ${input.bankAccountId ?? null}::uuid in(m.source_bank_account_id,m.destination_bank_account_id))
         and (${input.reversedOnly ?? false}::boolean=false or m.status='reversed')
         and (${input.missingJournalOnly ?? false}::boolean=false or
              (m.status='confirmed' and j.id is null))
         and (${search}::text is null or
              m.movement_number ilike '%'||${search}||'%' or
              coalesce(m.reference_number,'') ilike '%'||${search}||'%' or
              coalesce(m.external_reference,'') ilike '%'||${search}||'%')
         and (${input.movementNumber ?? null}::text is null
              or m.movement_number ilike '%'||${input.movementNumber ?? null}||'%')
         and (${input.referenceNumber ?? null}::text is null
              or coalesce(m.reference_number,'') ilike '%'||${input.referenceNumber ?? null}||'%'
              or coalesce(m.external_reference,'') ilike '%'||${input.referenceNumber ?? null}||'%')
         and (${input.amountFrom ?? null}::numeric is null
              or m.amount>=${input.amountFrom ?? null}::numeric)
         and (${input.amountTo ?? null}::numeric is null
              or m.amount<=${input.amountTo ?? null}::numeric)
         and (${input.createdByAccountId ?? null}::uuid is null
              or m.created_by_account_id=${input.createdByAccountId ?? null}::uuid)
         and (${input.excludeReversed ?? false}::boolean=false or m.status<>'reversed')
         and (${input.accountingStatus ?? null}::text is null
           or (${input.accountingStatus ?? null}='posted' and e.processing_status='posted')
           or (${input.accountingStatus ?? null}='failed'
               and e.processing_status in ('failed','blocked_configuration','blocked_period'))
           or (${input.accountingStatus ?? null}='pending'
               and (e.id is null
                    or e.processing_status in ('received','processing','retry_pending'))))
         and (${input.movementFamily ?? null}::text is null
           or (${input.movementFamily ?? null}='transfer' and m.movement_type like '%\\_to\\_%')
           or (${input.movementFamily ?? null}='fee' and m.fee_amount>0)
           or (${input.movementFamily ?? null}='cash' and m.movement_type in
               ('cash_deposit','cash_withdrawal'))
           or (${input.movementFamily ?? null}='bank' and m.movement_type in
               ('bank_deposit','bank_withdrawal')))
       order by ${sql.raw(sort)} ${sql.raw(direction)} nulls last,m.created_at desc,m.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    const totalCount = Number(result.rows[0]?.totalCount ?? 0);
    return {
      items: result.rows,
      page,
      pageSize,
      // `total` is preserved for existing callers; `totalCount` is the numeric
      // shape the paging controls use.
      total: String(totalCount),
      totalCount,
    };
  }

  /**
   * Everything the Movement form needs to render without the User typing an
   * identifier: the Company currency, today in the Company timezone, the
   * active Cash and Bank Accounts with their GL link resolved, the Movement
   * Types this backend genuinely supports together with the account shape each
   * one needs, and the Company's Segregation policy so the screen can offer
   * only actions that will succeed. Read-only.
   */
  public async movementContext() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const [configuration, settings, cash, bank, policy] = await Promise.all([
      sql<{ baseCurrency: string }>`
        select base_currency as "baseCurrency" from accounting_configurations
         where company_id=${companyId}::uuid
      `.execute(this.database),
      sql<{ timezone: string }>`
        select timezone from company_settings where company_id=${companyId}::uuid
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select c.id,c.cash_account_code as code,c.cash_account_name as name,
               c.cash_account_name_ar as "nameAr",c.currency,
               c.effective_from::text as "effectiveFrom",c.effective_to::text as "effectiveTo",
               a.code as "glAccountCode",a.name_en as "glAccountName",
               (a.id is not null and a.is_active and a.is_posting_account) as "glLinkValid"
          from company_cash_accounts c
          left join chart_of_accounts a
            on a.id=c.linked_gl_account_id and a.company_id=c.company_id
         where c.company_id=${companyId}::uuid and c.is_active
         order by c.cash_account_code
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select b.id,b.bank_account_code as code,b.account_name as name,
               b.bank_name as "bankName",b.currency,
               b.effective_from::text as "effectiveFrom",b.effective_to::text as "effectiveTo",
               a.code as "glAccountCode",a.name_en as "glAccountName",
               (a.id is not null and a.is_active and a.is_posting_account) as "glLinkValid"
          from company_bank_accounts b
          left join chart_of_accounts a
            on a.id=b.linked_gl_account_id and a.company_id=b.company_id
         where b.company_id=${companyId}::uuid and b.is_active
         order by b.bank_account_code
      `.execute(this.database),
      this.support.segregationPolicy(this.database),
    ]);
    const timezone = settings.rows[0]?.timezone ?? "Asia/Dubai";
    const parts = new Intl.DateTimeFormat("en", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    })
      .formatToParts(new Date())
      .reduce<Record<string, string>>((result, part) => {
        result[part.type] = part.value;
        return result;
      }, {});
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    // A Bank Fee posts to the `bank_charge` mapping. Reported up front so the
    // form can disable Add Bank Fee instead of failing at confirmation.
    const bankCharge = await this.mappings.resolveMappingAccount(
      this.database,
      companyId,
      "bank_charge",
      today,
      "debit",
    );
    return {
      bankAccounts: bank.rows,
      bankChargeAccount: bankCharge,
      cashAccounts: cash.rows,
      currency: configuration.rows[0]?.baseCurrency ?? "AED",
      // The lifecycle this backend actually implements — no Submit, no Approve.
      lifecycle: ["draft", "confirmed"],
      movementTypes: cashBankMovementTypes
        .filter((type) => movementShapes[type] !== undefined)
        .map((type) => ({ value: type, ...movementShapes[type]! })),
      segregationPolicy: policy,
      timezone,
      today,
    };
  }

  /**
   * Read-only preview of the Journal a Movement WOULD post, for a Movement
   * that need not exist yet. Creates no Movement, no Accounting Event and no
   * Journal, and writes nothing.
   *
   * The Debit/Credit shape mirrors `OperationalSourceLoader.cashBankMovement`
   * exactly: a transfer debits the destination GL and credits the source GL; a
   * deposit debits the destination GL and credits the classification mapping;
   * a withdrawal debits the classification mapping and credits the source GL;
   * and a fee adds a `bank_charge` debit with a matching credit to the source.
   */
  public async movementPreview(query: CashBankMovementPreviewQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const shape = movementShapes[query.movementType];
    const issues: string[] = [];
    if (shape === undefined) {
      return {
        confirmable: false,
        issues: ["accounting_cash_bank_movement_type_unsupported"],
        lines: [],
      };
    }
    const context = await this.movementContext();
    const accountingDate = query.accountingDate ?? String(context.today);
    const currency = String(context.currency);

    const amount = this.money(query.amount);
    const fee = this.money(query.feeAmount ?? "0");
    if (amount === undefined || !amount.greaterThan(0)) {
      issues.push("accounting_cash_bank_movement_invalid_amount");
    }
    if (fee === undefined || fee.isNegative()) issues.push("accounting_cash_bank_fee_invalid");

    const sourceId =
      shape.source === "cash" ? query.sourceCashAccountId : query.sourceBankAccountId;
    const destinationId =
      shape.destination === "cash"
        ? query.destinationCashAccountId
        : query.destinationBankAccountId;
    if (shape.source !== null && sourceId === undefined) issues.push("source_account_required");
    if (shape.destination !== null && destinationId === undefined) {
      issues.push("destination_account_required");
    }
    if (sourceId !== undefined && sourceId === destinationId) {
      issues.push("source_and_destination_must_differ");
    }
    // A fee is always taken from the source, so a Movement with no source
    // cannot carry one — the same rule `validMovementStructure` enforces.
    if (fee !== undefined && fee.greaterThan(0) && shape.source === null) {
      issues.push("fee_requires_source_account");
    }

    const source =
      shape.source === null || sourceId === undefined
        ? undefined
        : await this.financialAccount(shape.source, sourceId, accountingDate);
    const destination =
      shape.destination === null || destinationId === undefined
        ? undefined
        : await this.financialAccount(shape.destination, destinationId, accountingDate);
    for (const account of [source, destination]) {
      if (account === undefined) continue;
      if (!account.found) issues.push("account_not_found");
      else if (!account.active) issues.push("account_inactive_or_outside_effective_dates");
      else if (!account.withinEffectiveDates) {
        issues.push("account_inactive_or_outside_effective_dates");
      }
      if (account.found && account.currency !== currency) issues.push("currency_mismatch");
      if (account.found && account.glAccountId === null) issues.push("gl_link_missing");
    }

    // Fiscal Period, evaluated exactly as confirmation evaluates it.
    const period = await sql<{ count: string }>`
      select count(*)::text as count from accounting_periods p
      join fiscal_years y on y.id=p.fiscal_year_id and y.company_id=p.company_id
      where p.company_id=${companyId}::uuid
        and ${accountingDate}::date between p.period_start and p.period_end
        and p.status in('open','reopened') and y.status in('open','reopened')
    `.execute(this.database);
    if (period.rows[0]?.count !== "1") issues.push("period_unavailable");

    const lines: Record<string, unknown>[] = [];
    const amountText = amount === undefined ? "0.00" : amount.toFixed(2);
    const push = (
      account: {
        readonly accountCode: string | null;
        readonly accountNameAr: string | null;
        readonly accountNameEn: string | null;
      },
      intent: "credit" | "debit",
      value: string,
      description: string,
    ) => lines.push({ ...account, amount: value, description, entryIntent: intent });

    if (shape.classification === "transfer") {
      push(this.glOf(destination), "debit", amountText, "Destination account");
      push(this.glOf(source), "credit", amountText, "Source account");
    } else if (shape.classification === "deposit") {
      const key = query.classificationMappingKey ?? null;
      if (key === null) issues.push("classification_required");
      const external = await this.mappings.resolveMappingAccount(
        this.database,
        companyId,
        key,
        accountingDate,
        "credit",
      );
      if (external.issue !== null) issues.push(`${external.issue}:${key ?? ""}`);
      push(this.glOf(destination), "debit", amountText, "Receipt");
      push(external, "credit", amountText, "Source of funds");
    } else {
      const key = query.classificationMappingKey ?? null;
      if (key === null) issues.push("classification_required");
      const external = await this.mappings.resolveMappingAccount(
        this.database,
        companyId,
        key,
        accountingDate,
        "debit",
      );
      if (external.issue !== null) issues.push(`${external.issue}:${key ?? ""}`);
      push(external, "debit", amountText, "Destination of funds");
      push(this.glOf(source), "credit", amountText, "Payment");
    }

    let feeText = "0.00";
    if (fee !== undefined && fee.greaterThan(0)) {
      feeText = fee.toFixed(2);
      const charge = await this.mappings.resolveMappingAccount(
        this.database,
        companyId,
        "bank_charge",
        accountingDate,
        "debit",
      );
      if (charge.issue !== null) issues.push(`${charge.issue}:bank_charge`);
      push(charge, "debit", feeText, "Bank charge");
      push(this.glOf(source), "credit", feeText, "Fee taken from source");
    }

    const total = (intent: "credit" | "debit") =>
      lines
        .filter((line) => line.entryIntent === intent)
        .reduce((sum, line) => sum.plus(String(line.amount)), new Decimal(0));
    const debitTotal = total("debit");
    const creditTotal = total("credit");
    if (!debitTotal.equals(creditTotal)) issues.push("movement_not_balanced");
    if (lines.some((line) => line.accountCode === null)) issues.push("mapping_missing");

    const sourceEffect = new Decimal(amountText).plus(feeText);
    return {
      accountingDate,
      amount: amountText,
      confirmable: issues.length === 0,
      creditTotal: creditTotal.toFixed(2),
      currency,
      debitTotal: debitTotal.toFixed(2),
      destinationAccount: destination?.label ?? null,
      destinationEffect: shape.destination === null ? null : amountText,
      feeAmount: feeText,
      issues,
      lines,
      movementType: query.movementType,
      sourceAccount: source?.label ?? null,
      // The source always gives up the amount PLUS the fee.
      sourceEffect: shape.source === null ? null : sourceEffect.toFixed(2),
      treatment: shape.classification,
    };
  }

  private money(value: string | undefined): Decimal | undefined {
    try {
      const parsed = new Decimal(value ?? "0");
      return parsed.isFinite() ? parsed.toDecimalPlaces(2) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The mapping-shaped view of a financial account's linked GL Account. */
  private glOf(account: Awaited<ReturnType<CashBankQueryService["financialAccount"]>> | undefined) {
    return {
      accountCode: account?.glAccountCode ?? null,
      accountNameAr: account?.glAccountNameAr ?? null,
      accountNameEn: account?.glAccountNameEn ?? null,
    };
  }

  private async financialAccount(kind: "bank" | "cash", id: string, onDate: string) {
    const { companyId } = this.support.context();
    const result =
      kind === "cash"
        ? await sql<Record<string, unknown>>`
            select c.cash_account_code as code,c.cash_account_name as name,c.currency,
                   c.is_active as active,c.effective_from::text as "effectiveFrom",
                   c.effective_to::text as "effectiveTo",a.id as "glAccountId",
                   a.code as "glAccountCode",a.name_en as "glAccountNameEn",
                   a.name_ar as "glAccountNameAr"
              from company_cash_accounts c
              left join chart_of_accounts a
                on a.id=c.linked_gl_account_id and a.company_id=c.company_id
                and a.is_active and a.is_posting_account
             where c.id=${id}::uuid and c.company_id=${companyId}::uuid
          `.execute(this.database)
        : await sql<Record<string, unknown>>`
            select b.bank_account_code as code,b.account_name as name,b.currency,
                   b.is_active as active,b.effective_from::text as "effectiveFrom",
                   b.effective_to::text as "effectiveTo",a.id as "glAccountId",
                   a.code as "glAccountCode",a.name_en as "glAccountNameEn",
                   a.name_ar as "glAccountNameAr"
              from company_bank_accounts b
              left join chart_of_accounts a
                on a.id=b.linked_gl_account_id and a.company_id=b.company_id
                and a.is_active and a.is_posting_account
             where b.id=${id}::uuid and b.company_id=${companyId}::uuid
          `.execute(this.database);
    const row = result.rows[0];
    const effectiveFrom = row === undefined ? null : (row.effectiveFrom as string | null);
    const effectiveTo = row === undefined ? null : (row.effectiveTo as string | null);
    return {
      active: row?.active === true,
      currency: row === undefined ? null : String(row.currency ?? ""),
      found: row !== undefined,
      glAccountCode: row === undefined ? null : ((row.glAccountCode as string | null) ?? null),
      glAccountId: row === undefined ? null : ((row.glAccountId as string | null) ?? null),
      glAccountNameAr: row === undefined ? null : ((row.glAccountNameAr as string | null) ?? null),
      glAccountNameEn: row === undefined ? null : ((row.glAccountNameEn as string | null) ?? null),
      label: row === undefined ? null : `${String(row.code ?? "")} — ${String(row.name ?? "")}`,
      withinEffectiveDates:
        (effectiveFrom === null || effectiveFrom <= onDate) &&
        (effectiveTo === null || effectiveTo >= onDate),
    };
  }

  public async detail(id: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const movement = await sql<Record<string, unknown>>`
      select m.*,
             -- Business dates as YYYY-MM-DD text; returned as Date objects they
             -- serialise as UTC timestamps and can display the previous day.
             m.movement_date::text as "movementDate",
             m.accounting_date::text as "accountingDate",
             j.id as "journalId",j.journal_number as "journalNumber",
             -- error_code, not last_error_code: the latter has never existed on
             -- accounting_events, so this query failed with 42703 on every
             -- Movement ever opened.
             e.processing_status as "accountingEventStatus",e.error_code as "accountingErrorCode",
             e.safe_error_summary as "accountingErrorSummary",
             -- Business labels for every linked record, so the screen never has
             -- to show an identifier.
             sc.cash_account_code as "sourceCashAccountCode",
             sc.cash_account_name as "sourceCashAccountName",
             sb.bank_account_code as "sourceBankAccountCode",
             sb.account_name as "sourceBankAccountName",
             dc.cash_account_code as "destinationCashAccountCode",
             dc.cash_account_name as "destinationCashAccountName",
             db.bank_account_code as "destinationBankAccountCode",
             db.account_name as "destinationBankAccountName",
             rev.movement_number as "reversedByMovementNumber",
             orig.movement_number as "reversalOfMovementNumber",
             -- Identifiers the detail routes consume, alongside the business
             -- references above. Additive; no existing field changes.
             m.movement_number as "movementNumber",
             e.id as "accountingEventId",e.event_type as "accountingEventType",
             m.reversed_by_movement_id as "reversedByMovementId",
             m.reversal_of_movement_id as "reversalOfMovementId",
             revj.journal_number as "reversalJournalNumber",revj.id as "reversalJournalId"
        from cash_bank_movements m
        left join accounting_events e on e.id=m.accounting_event_id and e.company_id=m.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
        left join company_cash_accounts sc on sc.id=m.source_cash_account_id and sc.company_id=m.company_id
        left join company_bank_accounts sb on sb.id=m.source_bank_account_id and sb.company_id=m.company_id
        left join company_cash_accounts dc on dc.id=m.destination_cash_account_id and dc.company_id=m.company_id
        left join company_bank_accounts db on db.id=m.destination_bank_account_id and db.company_id=m.company_id
        left join cash_bank_movements rev
          on rev.id=m.reversed_by_movement_id and rev.company_id=m.company_id
        left join cash_bank_movements orig
          on orig.id=m.reversal_of_movement_id and orig.company_id=m.company_id
        left join accounting_events reve
          on reve.id=rev.accounting_event_id and reve.company_id=rev.company_id
        left join journal_entries revj
          on revj.id=reve.journal_id and revj.company_id=reve.company_id
       where m.id=${id}::uuid and m.company_id=${companyId}::uuid
    `.execute(this.database);
    if (movement.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_cash_bank_movement_not_found",
        "The Cash/Bank movement was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const attachments = await sql<Record<string, unknown>>`
      select id,file_object_id as "fileObjectId",attachment_type as "attachmentType",
             description,file_name_snapshot as "fileName",content_type_snapshot as "contentType",
             size_bytes_snapshot::text as "sizeBytes",uploaded_at as "uploadedAt"
        from cash_bank_movement_attachments
       where company_id=${companyId}::uuid and movement_id=${id}::uuid and is_active
       order by uploaded_at,id
    `.execute(this.database);
    return { ...movement.rows[0], attachments: attachments.rows };
  }

  public async summary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select count(*) filter(where status='draft')::text as "draftCount",
             count(*) filter(where status='confirmed')::text as "confirmedCount",
             count(*) filter(where status='reversed')::text as "reversedCount",
             coalesce(sum(amount) filter(where status='confirmed'),0)::text as "confirmedAmount",
             count(*) filter(where status='confirmed' and accounting_event_id is null)::text
               as "missingEventCount"
        from cash_bank_movements where company_id=${companyId}::uuid
    `.execute(this.database);
    return result.rows[0];
  }

  /**
   * Current balance of every Cash and Bank account.
   *
   * `database` lets a caller read inside its own transaction, so a payment
   * can read the balance, judge it and commit as one unit. It defaults to the
   * pool, which is what every existing caller wants.
   *
   * ==========================================================================
   * WHY THE OUTGOING PAYMENT TABLES ARE UNIONED INTO THE SAME CTE
   * ==========================================================================
   *
   * Payroll, outsourced Driver fees, General Expense payments and Trader
   * Settlements move money out of a Cash or Bank account without writing a
   * `cash_bank_movements` row. Until they were included here, this figure was
   * the Cash/Bank module's balance rather than the account's actual position,
   * and a negative-balance control judging a payroll payment against it would
   * have ignored every previous payroll payment.
   *
   * They are added as further legs of the EXISTING `movements` CTE, not as a
   * second calculation. One formula, extended, cannot disagree with itself; two
   * formulas for the same money drift the first time one is amended and nothing
   * says which is right. Opening balances, Movements, fees, reversal undo legs,
   * the source-negative/destination-positive treatment, account ordering and
   * the row shape are all untouched.
   *
   * ==========================================================================
   * EVERY BRANCH USES THE EXACT STORED FUNDING ACCOUNT
   * ==========================================================================
   *
   * No branch joins through a GL account to find the drawer. A GL account is
   * one-to-many with Cash accounts once a Company reuses a code, so that join
   * would attribute money to an account that may not have paid it.
   *
   * Rows written before the funding-account columns existed carry null and are
   * therefore excluded from every branch -- an excluded row moves no balance
   * rather than moving the wrong one. `coverage` reports how many were skipped,
   * per workflow, so the omission is stated instead of hidden. It deliberately
   * carries counts only: an amount total per account is exactly the guess the
   * null column exists to refuse.
   */
  public async balances(database: Kysely<DatabaseSchema> = this.database) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      with movements as (
        select source_cash_account_id as id,'cash'::text as kind,-amount-fee_amount as value
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select destination_cash_account_id,'cash',amount
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select source_bank_account_id,'bank',-amount-fee_amount
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select destination_bank_account_id,'bank',amount
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select o.source_cash_account_id,'cash',o.amount+o.fee_amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        union all select o.destination_cash_account_id,'cash',-o.amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        union all select o.source_bank_account_id,'bank',o.amount+o.fee_amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        union all select o.destination_bank_account_id,'bank',-o.amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        -- Payroll payments. Cash only by table CHECK, and a reversal flips the
        -- row's own status in place rather than writing a counter-row, so
        -- status='confirmed' both includes the live ones and excludes the
        -- reversed ones -- no undo leg is needed or correct here.
        union all select pp.company_cash_account_id,'cash',-pp.total_amount
          from payroll_payments pp
         where pp.company_id=${companyId}::uuid and pp.status='confirmed'
           and pp.company_cash_account_id is not null
        -- Outsourced Driver fee payments. A collection_offset nets the fee
        -- against cash the Driver already owes: no money leaves an account and
        -- the table forbids it naming one, so the method filter is what keeps
        -- an offset out of a balance it never touched.
        union all select fp.company_cash_account_id,'cash',-fp.amount_paid
          from outsourced_driver_fee_payments fp
         where fp.company_id=${companyId}::uuid and fp.status='confirmed'
           and fp.payment_method='cash' and fp.company_cash_account_id is not null
        union all select ep.company_cash_account_id,'cash',-ep.amount_paid
          from employee_variable_earning_payments ep
         where ep.company_id=${companyId}::uuid and ep.status='confirmed'
           and ep.company_cash_account_id is not null
        union all select ep.company_bank_account_id,'bank',-ep.amount_paid
          from employee_variable_earning_payments ep
         where ep.company_id=${companyId}::uuid and ep.status='confirmed'
           and ep.company_bank_account_id is not null
        union all select sa.company_cash_account_id,'cash',-sa.amount_paid
          from employee_salary_advances sa
         where sa.company_id=${companyId}::uuid and sa.status<>'reversed'
           and sa.company_cash_account_id is not null
        union all select sa.company_bank_account_id,'bank',-sa.amount_paid
          from employee_salary_advances sa
         where sa.company_id=${companyId}::uuid and sa.status<>'reversed'
           and sa.company_bank_account_id is not null
        -- General Expense payment ROWS, not the header. One payment may split
        -- across a Cash and a Bank account; each row carries its own amount and
        -- its own account, and the destination CHECK makes a row exactly one of
        -- the two -- so the cash and bank legs below cannot both claim it.
        union all select gr.company_cash_account_id,'cash',-gr.amount
          from general_expense_payment_rows gr
          join general_expense_payments gp
            on gp.id=gr.general_expense_payment_id and gp.company_id=gr.company_id
         where gr.company_id=${companyId}::uuid and gp.status='confirmed'
           and gr.company_cash_account_id is not null
        union all select gr.company_bank_account_id,'bank',-gr.amount
          from general_expense_payment_rows gr
          join general_expense_payments gp
            on gp.id=gr.general_expense_payment_id and gp.company_id=gr.company_id
         where gr.company_id=${companyId}::uuid and gp.status='confirmed'
           and gr.company_bank_account_id is not null
        -- Trader Settlements reverse by RAISING A NEW SETTLEMENT that points at
        -- the original, so the original keeps status='confirmed' forever. Three
        -- conditions are therefore all required: confirmed, not itself a
        -- reversal, and not the target of one. Testing status alone would count
        -- reversed settlements and their reversals both.
        union all select tp.company_cash_account_id,'cash',-tp.amount
          from trader_settlement_payments tp
          join trader_settlements ts on ts.id=tp.settlement_id and ts.company_id=tp.company_id
         where tp.company_id=${companyId}::uuid and ts.status='confirmed'
           and ts.reversal_of_id is null and tp.company_cash_account_id is not null
           and not exists (select 1 from trader_settlements rv
                            where rv.company_id=ts.company_id and rv.reversal_of_id=ts.id)
        union all select tp.company_bank_account_id,'bank',-tp.amount
          from trader_settlement_payments tp
          join trader_settlements ts on ts.id=tp.settlement_id and ts.company_id=tp.company_id
         where tp.company_id=${companyId}::uuid and ts.status='confirmed'
           and ts.reversal_of_id is null and tp.company_bank_account_id is not null
           and not exists (select 1 from trader_settlements rv
                            where rv.company_id=ts.company_id and rv.reversal_of_id=ts.id)
      ), coverage as (
        -- Counts only, of rows the branches above deliberately skipped. Same
        -- predicates, inverted on the account column alone, so a row is either
        -- counted in a balance or counted here and never both.
        select jsonb_build_object(
          'payrollPaymentsWithoutCashAccount',
            (select count(*)::int from payroll_payments
              where company_id=${companyId}::uuid and status='confirmed'
                and company_cash_account_id is null),
          'outsourcedDriverFeeCashPaymentsWithoutCashAccount',
            (select count(*)::int from outsourced_driver_fee_payments
              where company_id=${companyId}::uuid and status='confirmed'
                and payment_method='cash' and company_cash_account_id is null),
          'traderSettlementCashPaymentsWithoutCashAccount',
            (select count(*)::int from trader_settlement_payments tp
              join trader_settlements ts on ts.id=tp.settlement_id and ts.company_id=tp.company_id
             where tp.company_id=${companyId}::uuid and ts.status='confirmed'
               and ts.reversal_of_id is null and tp.payment_method='cash'
               and tp.company_cash_account_id is null
               and not exists (select 1 from trader_settlements rv
                                where rv.company_id=ts.company_id and rv.reversal_of_id=ts.id)),
          'generalExpenseCashRowsWithoutCompanyCashAccount',
            (select count(*)::int from general_expense_payment_rows gr
              join general_expense_payments gp
                on gp.id=gr.general_expense_payment_id and gp.company_id=gr.company_id
             where gr.company_id=${companyId}::uuid and gp.status='confirmed'
               and gr.payment_method='cash' and gr.company_cash_account_id is null)
        ) as value
      ), accounts as (
        select id,'cash'::text kind,cash_account_code code,cash_account_name name,is_active,
               linked_gl_account_id
          from company_cash_accounts where company_id=${companyId}::uuid
        union all
        select id,'bank',bank_account_code,account_name,is_active,linked_gl_account_id
          from company_bank_accounts where company_id=${companyId}::uuid
      ), opening as (
        select l.account_id,coalesce(sum(l.debit-l.credit),0) as value
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
           and j.journal_type='opening_balance'
         group by l.account_id
      )
      select a.id,a.kind,a.code,a.name,a.is_active as "isActive",
             (coalesce(o.value,0)+coalesce(sum(m.value),0))::numeric(18,2)::text as balance,
             -- Additive, and Company-level rather than per-account: the same
             -- object on every row. balances() must keep returning an ARRAY --
             -- reconciliation() maps it and FundingAccountBalanceService finds
             -- in it -- so wrapping the result in an envelope object would break
             -- both callers. Carried per row is the only shape that adds it
             -- without changing what the response IS.
             (select value from coverage) as coverage
        from accounts a left join movements m on m.id=a.id and m.kind=a.kind
        left join opening o on o.account_id=a.linked_gl_account_id
       group by a.id,a.kind,a.code,a.name,a.is_active,o.value order by a.kind,a.code
    `.execute(database);
    return result.rows;
  }

  public async ledger(kind: "cash" | "bank", accountId: string, input: CashBankListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const source =
      kind === "cash" ? sql.ref("m.source_cash_account_id") : sql.ref("m.source_bank_account_id");
    const destination =
      kind === "cash"
        ? sql.ref("m.destination_cash_account_id")
        : sql.ref("m.destination_bank_account_id");
    const originalSource =
      kind === "cash" ? sql.ref("o.source_cash_account_id") : sql.ref("o.source_bank_account_id");
    const originalDestination =
      kind === "cash"
        ? sql.ref("o.destination_cash_account_id")
        : sql.ref("o.destination_bank_account_id");
    const result = await sql<Record<string, unknown>>`
      with selected_account as (
        select linked_gl_account_id as gl_id from ${
          kind === "cash" ? sql`company_cash_accounts` : sql`company_bank_accounts`
        } where id=${accountId}::uuid and company_id=${companyId}::uuid
      ), opening as (
        select coalesce(sum(l.debit-l.credit),0) as amount
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
           and j.journal_type='opening_balance'
           and l.account_id=(select gl_id from selected_account)
      ), activity as (
        select m.id,m.movement_number,m.movement_type,m.accounting_date,m.status,
               m.reference_number,m.description,
               case when m.reversal_of_movement_id is null then
                 case when ${destination}=${accountId}::uuid then m.amount else 0 end
                 - case when ${source}=${accountId}::uuid then m.amount+m.fee_amount else 0 end
               else -(
                 case when ${originalDestination}=${accountId}::uuid then o.amount else 0 end
                 - case when ${originalSource}=${accountId}::uuid then o.amount+o.fee_amount else 0 end
               ) end as net
          from cash_bank_movements m
          left join cash_bank_movements o
            on o.id=m.reversal_of_movement_id and o.company_id=m.company_id
         where m.company_id=${companyId}::uuid and m.status in('confirmed','reversed')
           and (${input.dateTo ?? null}::date is null or m.accounting_date<=${input.dateTo ?? null}::date)
           and (${source}=${accountId}::uuid or ${destination}=${accountId}::uuid
             or ${originalSource}=${accountId}::uuid or ${originalDestination}=${accountId}::uuid)
      ), running as (
      select id,movement_number as "movementNumber",movement_type as "movementType",
             accounting_date::text as "accountingDate",status,reference_number as "referenceNumber",
             description,case when net>0 then net else 0 end::text as debit,
             case when net<0 then -net else 0 end::text as credit,net::text,
             (select amount from opening)::numeric(18,2)::text as "openingBalance",
             ((select amount from opening)+sum(net) over(
               order by accounting_date,movement_number,id
             ))::numeric(18,2)::text as "runningBalance"
        from activity
      )
      select * from running
       where (${input.dateFrom ?? null}::date is null
         or "accountingDate"::date>=${input.dateFrom ?? null}::date)
       order by "accountingDate","movementNumber",id
    `.execute(this.database);
    let openingBalance = result.rows[0]?.openingBalance;
    if (openingBalance === undefined) {
      const opening = await sql<{ value: string }>`
        select coalesce(sum(l.debit-l.credit),0)::numeric(18,2)::text as value
          from ${kind === "cash" ? sql`company_cash_accounts` : sql`company_bank_accounts`} a
          left join journal_lines l
            on l.account_id=a.linked_gl_account_id and l.company_id=a.company_id
          left join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
           and j.status='posted' and j.journal_type='opening_balance'
         where a.id=${accountId}::uuid and a.company_id=${companyId}::uuid
      `.execute(this.database);
      openingBalance = opening.rows[0]?.value ?? "0.00";
    }
    return {
      accountId,
      accountKind: kind,
      openingBalance,
      items: result.rows,
    };
  }

  public async reconciliation() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select m.id,m.movement_number as "movementNumber",m.accounting_date::text as "accountingDate",
             m.movement_type as "movementType",m.amount::text,m.fee_amount::text as "feeAmount",
             m.status,e.processing_status as "eventStatus",e.error_code as "errorCode",
             j.id as "journalId",j.journal_number as "journalNumber"
        from cash_bank_movements m
        left join accounting_events e on e.id=m.accounting_event_id and e.company_id=m.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
       where m.company_id=${companyId}::uuid and m.status in('confirmed','reversed')
         and (e.id is null or e.processing_status<>'posted' or j.id is null)
       order by m.accounting_date,m.movement_number
    `.execute(this.database);
    const operational = await this.balances();
    const ledger = await sql<Record<string, unknown>>`
      with accounts as (
        select id,'cash'::text kind,linked_gl_account_id gl_id
          from company_cash_accounts where company_id=${companyId}::uuid
        union all
        select id,'bank',linked_gl_account_id
          from company_bank_accounts where company_id=${companyId}::uuid
      ), totals as (
        select l.account_id,coalesce(sum(l.debit-l.credit),0)::numeric(18,2) value
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
         group by l.account_id
      )
      select a.id,a.kind,coalesce(t.value,0)::text as "ledgerBalance"
        from accounts a left join totals t on t.account_id=a.gl_id
       order by a.kind,a.id
    `.execute(this.database);
    const ledgerByAccount = new Map(
      ledger.rows.map((row) => [`${String(row.kind)}:${String(row.id)}`, row.ledgerBalance]),
    );
    return {
      accountBalances: operational.map((row) => ({
        ...row,
        ledgerBalance: ledgerByAccount.get(`${String(row.kind)}:${String(row.id)}`) ?? "0.00",
      })),
      postingExceptions: result.rows,
    };
  }

  public async previewBackfill(input: CashBankBackfillPreviewDto) {
    this.support.assertPermission("accounting.manage");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select m.id,m.movement_number as "movementNumber",m.movement_type as "movementType",
             m.accounting_date::text as "accountingDate",m.amount::text,m.fee_amount::text as "feeAmount",
             case when m.status not in('confirmed','reversed') then 'not_financial'
                  when m.accounting_event_id is not null then 'already_represented'
                  when m.movement_type='opening_balance' then 'opening_balance_workflow_required'
                  else 'eligible_for_controlled_backfill' end as outcome
        from cash_bank_movements m
       where m.company_id=${companyId}::uuid
         and m.accounting_date between ${input.dateFrom}::date and ${input.dateTo}::date
         and (${input.accountId ?? null}::uuid is null or ${input.accountId ?? null}::uuid in(
           m.source_cash_account_id,m.destination_cash_account_id,
           m.source_bank_account_id,m.destination_bank_account_id))
       order by m.accounting_date,m.movement_number
    `.execute(this.database);
    return {
      readOnly: true,
      noHistoricalPostingPerformed: true,
      items: result.rows,
    };
  }
}
