import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type RawBuilder, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { traderMayOweFeeSql } from "./cod-shortfall.js";
import { effectiveSettlement } from "./effective-settlement-offsets.js";
import { issueAnomalyListSql, receivableAnomalySql } from "./trader-receivable-reconciliation.js";
import {
  type FinancialVerificationClassification,
  type OrderFinancialHealth,
  orderFinancialHealth,
} from "./order-financial-classification.js";

/**
 * COMPANY ORDER HEALTH -- "does this Company currently have problematic Orders?"
 *
 * A read-only, company-wide, SET-BASED evaluation of every Order of ONE
 * explicitly named Company. It is THE financial decision: the per-Order
 * Verify First (`OrderMaintenanceService.financialVerification`) and the
 * Repair Center both read `orderEvaluation` -- the same statement narrowed to
 * one Order -- instead of classifying on their own (Repair Center Phase 3,
 * Prompt 2). It re-uses the certified domain rules rather than inventing new
 * ones:
 *
 *   - Trader receivable classification: the receivable reconciliation of
 *     trader-receivable-reconciliation.ts first (ISSUE codes ->
 *     RECEIVABLE_INCONSISTENT, review codes -> NEEDS_REVIEW), then the
 *     classifications of order-financial-classification.ts, mapped to
 *     HEALTHY / ISSUE / REVIEW through the shared `ORDER_FINANCIAL_HEALTH`
 *     table. A Receivable fully satisfied by currently EFFECTIVE Settlement
 *     offsets is HEALTHY, needs no action, and is never reset.
 *   - Effective vs historical offsets: `effective-settlement-offsets.ts`.
 *     SET-A -> SET-A reversal -> SET-B is ONE settlement (AED 18 effective),
 *     never two; historical offsets are never counted.
 *   - Physical collections: allocations of still-confirmed Trader Collections
 *     only, kept separate from offsets.
 *   - What the Trader owes: the order financial model
 *     (`calculateOrderFinancials(...).traderReceivableDue`), expressed in SQL
 *     by `traderReceivableDueSql` below and pinned to the TypeScript model by
 *     a parity test. A Receivable is NEVER inferred from `service_fee > 0`.
 *   - Accounting mode semantics: an Order delivered while GL Accounting was
 *     OFF needs no Accounting Event (`accounting_enabled_at`, the same rule
 *     as the Integrity Checker); accounting failures only count while the
 *     Company's GL Accounting is ON.
 *
 * Performance: every Order is evaluated by ONE statement built from
 * company-scoped aggregate CTEs (hash joins, no per-Order round trips and no
 * N+1). Filtering, sorting, counting and pagination all happen in PostgreSQL.
 * Each request runs a fixed number of statements (context + one evaluation)
 * whatever the Company's size.
 *
 * Read-only: every statement runs inside `set transaction read only`, so
 * PostgreSQL itself refuses any write. Nothing is persisted -- no scan
 * result, no audit row, no cache.
 *
 * Privacy: no customer name, mobile or address is selected. Rows carry the
 * Order number, delivery status and Order date only; the list never carries a
 * Settlement, Receivable or Journal number.
 */

export type OrderHealthFilter = "attention" | "issue" | "review" | "healthy" | "all";
export type OrderHealthDateScope = "today" | "last7" | "last30" | "custom" | "all";

export const ORDER_HEALTH_FILTERS: readonly OrderHealthFilter[] = [
  "attention",
  "issue",
  "review",
  "healthy",
  "all",
];
export const ORDER_HEALTH_DATE_SCOPES: readonly OrderHealthDateScope[] = [
  "today",
  "last7",
  "last30",
  "custom",
  "all",
];

export type OrderHealthRecommendedAction =
  | "none"
  | "repair_trader_receivable"
  | "reconcile_trader_receivable"
  | "review_in_verify_first"
  | "review_accounting"
  | "review_driver_cash";

export type OrderHealthClassification =
  | FinancialVerificationClassification
  | "ACCOUNTING_FAILURE"
  | "DRIVER_CASH_INCONSISTENT";

interface ReasonDefinition {
  readonly health: OrderFinancialHealth;
  /** Set for findings that are not a Trader receivable classification. */
  readonly classification?: OrderHealthClassification;
  readonly reason: string;
  readonly recommendedAction: OrderHealthRecommendedAction;
}

/**
 * Every reason code the evaluation can produce. Reasons are written for an
 * administrator and deliberately carry NO identifiers (no Settlement,
 * Receivable or Journal number, no UUID, no customer data).
 *
 * Trader receivable codes take their health from `ORDER_FINANCIAL_HEALTH`, so
 * this table cannot drift from Verify First.
 */
export const ORDER_HEALTH_REASONS = {
  // ---- Trader receivable: healthy classifications
  NO_TRADER_RECEIVABLE_REQUIRED: {
    health: orderFinancialHealth("NO_TRADER_RECEIVABLE_REQUIRED"),
    reason: "No Trader receivable is required for this order.",
    recommendedAction: "none",
  },
  HEALTHY_ACTIVE_RECEIVABLE: {
    health: orderFinancialHealth("HEALTHY_ACTIVE_RECEIVABLE"),
    reason: "The Trader receivable is open and awaiting collection.",
    recommendedAction: "none",
  },
  ALREADY_PHYSICALLY_COLLECTED: {
    health: orderFinancialHealth("ALREADY_PHYSICALLY_COLLECTED"),
    reason: "The Trader payment was physically collected.",
    recommendedAction: "none",
  },
  OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION: {
    health: orderFinancialHealth("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"),
    reason: "The Trader receivable was settled by an effective settlement offset.",
    recommendedAction: "none",
  },
  // Phase 3: a physical collection plus an effective offset that together
  // settle the amount due (the Verify First classification is
  // ALREADY_PHYSICALLY_COLLECTED: the money was received).
  SETTLED_BY_COLLECTION_AND_OFFSET: {
    classification: "ALREADY_PHYSICALLY_COLLECTED",
    health: orderFinancialHealth("ALREADY_PHYSICALLY_COLLECTED"),
    reason: "The Trader receivable was settled by a physical collection and a settlement offset.",
    recommendedAction: "none",
  },
  // ---- Trader receivable: actionable inconsistencies
  MISSING_RECEIVABLE: {
    health: orderFinancialHealth("MISSING_RECEIVABLE"),
    reason: "A Trader receivable is required for this order but is missing.",
    recommendedAction: "repair_trader_receivable",
  },
  REVERSED_NEEDS_REPAIR: {
    health: orderFinancialHealth("REVERSED_NEEDS_REPAIR"),
    reason: "Only a reversed Trader receivable remains; a current one is required.",
    recommendedAction: "repair_trader_receivable",
  },
  // ---- Trader receivable: NEEDS_REVIEW, by cause
  MULTIPLE_EFFECTIVE_SETTLEMENTS: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason: "The Trader receivable is offset by more than one effective settlement.",
    recommendedAction: "review_in_verify_first",
  },
  RECEIVABLE_OVER_COLLECTED: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason: "Effective collections and offsets exceed the Trader receivable amount due.",
    recommendedAction: "review_in_verify_first",
  },
  RECEIVABLE_COLLECTED_AMOUNT_MISMATCH: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason:
      "The recorded collected amount disagrees with effective collections and offsets.",
    recommendedAction: "review_in_verify_first",
  },
  MULTIPLE_ACTIVE_RECEIVABLES: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason: "More than one active Trader receivable exists for this order.",
    recommendedAction: "review_in_verify_first",
  },
  RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason: "An active Trader receivable exists although the customer's COD covers the fee.",
    recommendedAction: "review_in_verify_first",
  },
  // Phase 3 Prompt 4: a legacy Order (no coherent VAT / obligation snapshot)
  // whose receivable differs from today's rules -- what it required when it
  // was created cannot be proven, so it is REVIEW, never ISSUE.
  RECEIVABLE_AMOUNT_NOT_PROVABLE: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason:
      "The Trader receivable amount differs from today's rules, and this older order has no VAT snapshot proving what it required.",
    recommendedAction: "review_in_verify_first",
  },
  RECEIVABLE_STATE_INCONSISTENT: {
    health: orderFinancialHealth("NEEDS_REVIEW"),
    reason: "The Trader receivable and its clearing records are inconsistent.",
    recommendedAction: "review_in_verify_first",
  },
  // ---- Trader receivable: actionable reconciliation inconsistencies (Phase 3,
  //      trader-receivable-reconciliation.ts). The decision classifies them
  //      RECEIVABLE_INCONSISTENT (ISSUE). Plain sentences, no identifiers.
  RECEIVABLE_AMOUNT_MISMATCH: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "The Trader receivable amount does not match the order.",
    recommendedAction: "review_in_verify_first",
  },
  COLLECTION_ALLOCATION_MISMATCH: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "A Trader payment is applied inconsistently to this order's receivable.",
    recommendedAction: "review_in_verify_first",
  },
  ORPHAN_COLLECTION_ALLOCATION: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "A Trader payment is still applied to a cancelled or reversed receivable.",
    recommendedAction: "review_in_verify_first",
  },
  SETTLEMENT_OFFSET_MISMATCH: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "A settlement deduction does not match this order's Trader receivable.",
    recommendedAction: "review_in_verify_first",
  },
  RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "The Trader receivable is marked paid, but no payment or settlement supports it.",
    recommendedAction: "reconcile_trader_receivable",
  },
  FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "The Trader receivable is fully paid but still shows as open.",
    recommendedAction: "reconcile_trader_receivable",
  },
  RECEIVABLE_PARTIAL_STATE_MISMATCH: {
    health: orderFinancialHealth("RECEIVABLE_INCONSISTENT"),
    reason: "The Trader payment state is inconsistent with the payments recorded.",
    recommendedAction: "reconcile_trader_receivable",
  },
  // ---- Accounting (only where GL Accounting applies)
  ORDER_MISSING_ACCOUNTING_EVENT: {
    classification: "ACCOUNTING_FAILURE",
    health: "ISSUE",
    reason:
      "The order was delivered while GL Accounting was ON, but no accounting event was captured.",
    recommendedAction: "review_accounting",
  },
  ACCOUNTING_EVENT_FAILED: {
    classification: "ACCOUNTING_FAILURE",
    health: "ISSUE",
    reason: "The order's accounting event failed and has not been posted.",
    recommendedAction: "review_accounting",
  },
  // ---- Driver Cash (on hold: high-confidence checks only, never ISSUE)
  DRIVER_CASH_RECONCILED_WITHOUT_RECONCILIATION: {
    classification: "DRIVER_CASH_INCONSISTENT",
    health: "REVIEW",
    reason:
      "Driver cash is marked reconciled, but no effective driver reconciliation includes the order.",
    recommendedAction: "review_driver_cash",
  },
  DRIVER_CASH_RECONCILIATION_NOT_REFLECTED: {
    classification: "DRIVER_CASH_INCONSISTENT",
    health: "REVIEW",
    reason:
      "An effective driver reconciliation includes the order, but the order is not marked reconciled.",
    recommendedAction: "review_driver_cash",
  },
} as const satisfies Record<string, ReasonDefinition>;

export type OrderHealthReasonCode = keyof typeof ORDER_HEALTH_REASONS;
export const ORDER_HEALTH_REASON_CODES = Object.keys(
  ORDER_HEALTH_REASONS,
) as OrderHealthReasonCode[];

const ISSUE_REASON_CODES = ORDER_HEALTH_REASON_CODES.filter(
  (code) => ORDER_HEALTH_REASONS[code].health === "ISSUE",
);

export interface OrderHealthRow {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderDate: string;
  readonly deliveryStatus: string;
  readonly health: OrderFinancialHealth;
  readonly classification: OrderHealthClassification;
  readonly reasonCode: OrderHealthReasonCode;
  readonly reason: string;
  readonly recommendedAction: OrderHealthRecommendedAction;
  /** Further findings on the same Order, after the primary `reasonCode`. */
  readonly additionalReasonCodes: readonly OrderHealthReasonCode[];
}

/** One Order's evaluation, with the evidence the Repair Center explains. */
export interface OrderHealthEvaluation extends OrderHealthRow {
  readonly financialClassification: FinancialVerificationClassification;
  /** The Trader receivable reason code (healthy or not). */
  readonly financialCode: OrderHealthReasonCode;
  /** Every non-healthy finding, most severe first. */
  readonly findingCodes: readonly OrderHealthReasonCode[];
  /** Whether the Order requires a Trader receivable (expected amount > 0). */
  readonly owes: boolean;
  /**
   * THE expected Trader receivable amount (Phase 3 Prompt 4,
   * `expectedTraderReceivableSql`): what the Order required when its financial
   * obligation was set -- from the Order's own stored obligation, never from a
   * later Company VAT setting. For a legacy Order it is indicative only (see
   * `amountProvable`).
   */
  readonly traderDue: string;
  /**
   * True when `traderDue` is proven by the Order's own financial snapshot (or
   * no receivable is required). False for a legacy Order without a coherent
   * snapshot: nothing that sets or replaces an amount is ever offered then.
   */
  readonly amountProvable: boolean;
  readonly receivableCount: number;
  readonly activeReceivableCount: number;
  readonly activeOffset: string;
  readonly activePhysical: string;
}

export interface OrderHealthScopeInput {
  readonly scope?: OrderHealthDateScope | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
}

export interface OrderHealthListInput extends OrderHealthScopeInput {
  readonly health?: OrderHealthFilter | undefined;
  readonly search?: string | undefined;
  readonly deliveryStatus?: string | undefined;
  readonly reasonCode?: OrderHealthReasonCode | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface ResolvedOrderHealthScope {
  readonly scope: OrderHealthDateScope;
  /** Inclusive bounds on the Order date; both null for "all". */
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  /** The Company's "today", in its own business-day timezone. */
  readonly today: string;
  readonly timezone: string;
  readonly dateBasis: "order_date";
}

export interface CompanyOrderHealthContext {
  readonly company: {
    readonly id: string;
    readonly code: string;
    readonly nameEn: string;
    readonly status: string;
    readonly environment: string | null;
  };
  readonly accountingMode: { readonly enabled: boolean };
}

export interface CompanyOrderHealthSummary extends CompanyOrderHealthContext {
  readonly generatedAt: string;
  readonly scope: ResolvedOrderHealthScope;
  readonly companyHealth: OrderFinancialHealth;
  readonly totalOrders: number;
  readonly healthyOrders: number;
  readonly issueOrders: number;
  readonly reviewOrders: number;
  readonly byReason: readonly {
    readonly reasonCode: OrderHealthReasonCode;
    readonly health: OrderFinancialHealth;
    readonly reason: string;
    readonly orders: number;
  }[];
}

export interface CompanyOrderHealthPage {
  readonly generatedAt: string;
  readonly scope: ResolvedOrderHealthScope;
  readonly filter: {
    readonly health: OrderHealthFilter;
    readonly search: string | null;
    readonly deliveryStatus: string | null;
    readonly reasonCode: OrderHealthReasonCode | null;
  };
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly OrderHealthRow[];
}

export const ORDER_HEALTH_DEFAULT_PAGE_SIZE = 25;
export const ORDER_HEALTH_MAX_PAGE_SIZE = 100;
const DEFAULT_TIMEZONE = "Asia/Dubai";
const STATEMENT_TIMEOUT = "60s";

const isoDate = /^\d{4}-\d{2}-\d{2}$/u;

function validDate(value: string | undefined, field: string): string {
  if (value === undefined || !isoDate.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApplicationException(
      "order_health_date_invalid",
      `${field} must be a valid date (YYYY-MM-DD)`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Resolves the requested date scope against the Company's own "today".
 * Pure, so the boundaries are unit-tested without a database.
 */
export function resolveOrderHealthScope(
  input: OrderHealthScopeInput,
  today: string,
  timezone: string,
): ResolvedOrderHealthScope {
  const scope = input.scope ?? "last30";
  const base = { dateBasis: "order_date" as const, scope, timezone, today };
  switch (scope) {
    case "all":
      return { ...base, dateFrom: null, dateTo: null };
    case "today":
      return { ...base, dateFrom: today, dateTo: today };
    case "last7":
      return { ...base, dateFrom: addDays(today, -6), dateTo: today };
    case "last30":
      return { ...base, dateFrom: addDays(today, -29), dateTo: today };
    case "custom": {
      const dateFrom = validDate(input.dateFrom, "dateFrom");
      const dateTo = validDate(input.dateTo, "dateTo");
      if (dateFrom > dateTo) {
        throw new ApplicationException(
          "order_health_date_range_invalid",
          "dateFrom must be on or before dateTo",
          HttpStatus.BAD_REQUEST,
        );
      }
      return { ...base, dateFrom, dateTo };
    }
    default:
      throw new ApplicationException(
        "order_health_scope_invalid",
        "Unknown date scope",
        HttpStatus.BAD_REQUEST,
      );
  }
}

/**
 * VAT of `amount` under the Company VAT policy -- `calculateVatAmount` in
 * SQL. `vat` is the alias of a row carrying `enabled`, `price_mode`, `rate`.
 * `round(numeric, 2)` rounds half away from zero, i.e. ROUND_HALF_UP for the
 * non-negative money amounts it is applied to.
 */
function vatSql(amount: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`(case
    when not vat.enabled or vat.rate = 0 then 0::numeric
    when vat.price_mode = 'inclusive' then round(${amount} * vat.rate / (100 + vat.rate), 2)
    else round(${amount} * vat.rate / 100, 2)
  end)`;
}

/**
 * `calculateOrderFinancials(...).traderReceivableDue`, in SQL, for the Order
 * row aliased `o` (columns `payment_condition`, `cod_amount`, `service_fee`,
 * `additional_fees`) under the policy aliased `vat`.
 *
 * For a "Trader pays fee" Order both calculation modes of the model reduce to
 * the same value -- max(fee incl. VAT + additional fees incl. VAT - COD, 0) --
 * and for every other payment condition the model returns 0 -- except a "Pay
 * by Customer" Order with a COD above 0 in a Company that charges the COD
 * shortfall to the Trader (cod-shortfall.ts), which reduces to the same
 * max(fees - COD, 0). The parity test
 * (`company-order-health.database.test.ts`) evaluates this expression and the
 * TypeScript model over a grid of fees, COD amounts and VAT policies.
 */
export function traderReceivableDueSql(): RawBuilder<string> {
  const fee = sql`o.service_fee`;
  const additional = sql`coalesce(o.additional_fees, 0)`;
  return sql<string>`(case
    when not ${traderMayOweFeeSql("o")} then 0::numeric
    else greatest(
      (case
        when vat.enabled and vat.price_mode = 'inclusive' then ${fee} + ${additional}
        else ${fee} + ${vatSql(fee)} + ${additional} + ${vatSql(additional)}
      end) - o.cod_amount,
      0)
  end)`;
}

/** The VAT of `amount` under the Order's OWN snapshot (aliased `o`). */
function snapshotVatSql(amount: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`(case
    when not o.vat_enabled_snapshot or coalesce(o.vat_rate_snapshot, 0) = 0 then 0::numeric
    when o.vat_price_mode_snapshot = 'inclusive'
      then round(${amount} * o.vat_rate_snapshot / (100 + o.vat_rate_snapshot), 2)
    else round(${amount} * o.vat_rate_snapshot / 100, 2)
  end)`;
}

/**
 * HISTORICAL FINANCIAL TRUTH (Repair Center Phase 3, Prompt 4).
 *
 * Is the Order's expected Trader receivable PROVEN by its own records? True
 * when no receivable is required, or when the Order is a
 * `trader_deduction_v1` Order whose stored obligation is complete and
 * coherent:
 *   - the VAT snapshot it was priced under is present;
 *   - net fee + fee VAT + additional fees + additional VAT = total deductions;
 *   - the stored fee VAT is exactly the snapshot rule applied to the fee.
 * Order creation stores these under the VAT policy then in force, and Order
 * editing recomputes them from the Order's OWN snapshot
 * (`OperationsService.updateOrder`), so they ARE the historical obligation. A
 * later Company VAT change never touches them.
 *
 * False for a legacy Order (no model version / snapshot): there is no record
 * of the VAT policy it was created under, and none is ever guessed.
 */
export function historicalAmountProvableSql(): RawBuilder<boolean> {
  return sql<boolean>`(not ${traderMayOweFeeSql("o")}
    or (o.financial_model_version = 'trader_deduction_v1'
        and o.vat_enabled_snapshot is not null
        and o.total_deductions is not null and o.service_fee_net_amount is not null
        and o.service_fee_vat_amount is not null and o.additional_fees is not null
        and o.additional_fee_vat_amount is not null
        and o.service_fee_net_amount + o.service_fee_vat_amount + o.additional_fees
            + o.additional_fee_vat_amount = o.total_deductions
        and o.service_fee_vat_amount = ${snapshotVatSql(sql`o.service_fee`)}))`;
}

/**
 * THE expected Trader receivable amount -- the one rule every reader uses
 * (Company Health, Verify First, Repair Preview, repairability, both
 * receivable-creating repairs and post-repair verification all read it
 * through `OrderHealthEvaluation.traderDue`).
 *
 *   no Trader-paid fee                 -> 0
 *   provable (historicalAmountProvableSql)
 *                                      -> greatest(total_deductions - COD, 0):
 *                                         exactly `traderReceivableDue` of the
 *                                         order financial model at the time the
 *                                         obligation was set
 *   legacy (not provable)              -> the model under the CURRENT policy,
 *                                         INDICATIVE ONLY: it decides whether a
 *                                         receivable is expected at all, and a
 *                                         receivable that disagrees with it is
 *                                         REVIEW (RECEIVABLE_AMOUNT_NOT_PROVABLE),
 *                                         never ISSUE and never auto-repaired.
 */
export function expectedTraderReceivableSql(
  /** A precomputed `historicalAmountProvableSql()` column, to evaluate it once per row. */
  provable: RawBuilder<unknown> = historicalAmountProvableSql(),
): RawBuilder<string> {
  return sql<string>`(case
    when not ${traderMayOweFeeSql("o")} then 0::numeric
    when ${provable} then greatest(o.total_deductions - o.cod_amount, 0)
    else ${traderReceivableDueSql()}
  end)`;
}

interface ContextRow {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly status: string;
  readonly environment: string | null;
  readonly accountingEnabled: boolean;
  readonly timezone: string | null;
  readonly today: string;
}

@Injectable()
export class CompanyOrderHealthService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** Company identity, Accounting mode and the resolved date scope. */
  public async summary(
    companyId: string,
    input: OrderHealthScopeInput = {},
  ): Promise<CompanyOrderHealthSummary> {
    return this.readOnly(async (db) => {
      const { context, scope } = await this.context(db, companyId, input);
      const rows = (
        await sql<{
          reasonCode: OrderHealthReasonCode;
          health: OrderFinancialHealth;
          orders: number;
        }>`
          ${this.evaluation(companyId, scope)}
          select reason_code as "reasonCode", health, count(*)::int as orders
            from evaluated
           group by reason_code, health
        `.execute(db)
      ).rows;
      const count = (health: OrderFinancialHealth): number =>
        rows.filter((row) => row.health === health).reduce((sum, row) => sum + row.orders, 0);
      const issueOrders = count("ISSUE");
      const reviewOrders = count("REVIEW");
      const healthyOrders = count("HEALTHY");
      const severity: Record<OrderFinancialHealth, number> = { ISSUE: 0, REVIEW: 1, HEALTHY: 2 };
      return {
        ...context,
        byReason: rows
          .map((row) => ({
            health: row.health,
            orders: row.orders,
            reason: ORDER_HEALTH_REASONS[row.reasonCode].reason,
            reasonCode: row.reasonCode,
          }))
          .sort(
            (a, b) =>
              severity[a.health] - severity[b.health] ||
              b.orders - a.orders ||
              a.reasonCode.localeCompare(b.reasonCode),
          ),
        companyHealth: issueOrders > 0 ? "ISSUE" : reviewOrders > 0 ? "REVIEW" : "HEALTHY",
        generatedAt: new Date().toISOString(),
        healthyOrders,
        issueOrders,
        reviewOrders,
        scope,
        totalOrders: healthyOrders + issueOrders + reviewOrders,
      };
    });
  }

  /** One page of Orders, filtered, sorted and paginated in PostgreSQL. */
  public async list(companyId: string, input: OrderHealthListInput = {}): Promise<CompanyOrderHealthPage> {
    const health = input.health ?? "attention";
    if (!ORDER_HEALTH_FILTERS.includes(health)) {
      throw new ApplicationException(
        "order_health_filter_invalid",
        "Unknown health filter",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.reasonCode !== undefined && !ORDER_HEALTH_REASON_CODES.includes(input.reasonCode)) {
      throw new ApplicationException(
        "order_health_reason_invalid",
        "Unknown reason code",
        HttpStatus.BAD_REQUEST,
      );
    }
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const pageSize = Math.min(
      ORDER_HEALTH_MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(input.pageSize ?? ORDER_HEALTH_DEFAULT_PAGE_SIZE)),
    );
    const search = input.search?.trim() ? input.search.trim() : null;
    const deliveryStatus = input.deliveryStatus?.trim() ? input.deliveryStatus.trim() : null;
    const reasonCode = input.reasonCode ?? null;
    const healthValues: readonly OrderFinancialHealth[] =
      health === "attention"
        ? ["ISSUE", "REVIEW"]
        : health === "issue"
          ? ["ISSUE"]
          : health === "review"
            ? ["REVIEW"]
            : health === "healthy"
              ? ["HEALTHY"]
              : ["ISSUE", "REVIEW", "HEALTHY"];
    const pattern =
      search === null ? null : `%${search.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;

    return this.readOnly(async (db) => {
      const { scope } = await this.context(db, companyId, input);
      const rows = (
        await sql<{
          orderId: string;
          orderNumber: string;
          orderDate: string;
          deliveryStatus: string;
          health: OrderFinancialHealth;
          financialClassification: FinancialVerificationClassification;
          reasonCode: OrderHealthReasonCode;
          findingCodes: OrderHealthReasonCode[];
          total: number;
        }>`
          ${this.evaluation(companyId, scope)}
          select e.id::text as "orderId", e.order_number as "orderNumber",
                 e.order_date::text as "orderDate", e.delivery_status as "deliveryStatus",
                 e.health, e.fin_class as "financialClassification",
                 e.reason_code as "reasonCode", e.finding_codes as "findingCodes",
                 count(*) over ()::int as total
            from evaluated e
           where e.health = any(${sql.raw(`array[${healthValues.map((value) => `'${value}'`).join(",")}]`)})
             and (${pattern}::text is null or e.order_number ilike ${pattern}::text)
             and (${deliveryStatus}::text is null or e.delivery_status = ${deliveryStatus}::text)
             and (${reasonCode}::text is null or ${reasonCode}::text = any(e.all_codes))
           order by case e.health when 'ISSUE' then 0 when 'REVIEW' then 1 else 2 end,
                    e.order_date desc, e.order_number desc
           limit ${pageSize} offset ${(page - 1) * pageSize}
        `.execute(db)
      ).rows;
      // An out-of-range page returns no row, so it cannot carry the window
      // count; the total is then re-read from the same scope only when needed.
      const total =
        rows[0]?.total ??
        (page > 1
          ? (
              await sql<{ total: number }>`
                ${this.evaluation(companyId, scope)}
                select count(*)::int as total from evaluated e
                 where e.health = any(${sql.raw(`array[${healthValues.map((value) => `'${value}'`).join(",")}]`)})
                   and (${pattern}::text is null or e.order_number ilike ${pattern}::text)
                   and (${deliveryStatus}::text is null or e.delivery_status = ${deliveryStatus}::text)
                   and (${reasonCode}::text is null or ${reasonCode}::text = any(e.all_codes))
              `.execute(db)
            ).rows[0]?.total ?? 0
          : 0);
      return {
        filter: { deliveryStatus, health, reasonCode, search },
        generatedAt: new Date().toISOString(),
        items: rows.map((row) => toOrderHealthRow(row)),
        page,
        pageSize,
        scope,
        total,
      };
    });
  }

  /**
   * Company identity and Accounting mode, inside the CALLER's (read-only)
   * transaction. Used by the Repair Center preview.
   */
  public async companyContext(
    db: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<CompanyOrderHealthContext> {
    return (await this.context(db, companyId, { scope: "all" })).context;
  }

  /**
   * The SAME evaluation as the company-wide health check, narrowed to ONE
   * Order, inside the caller's transaction. `undefined` when the Order does
   * not belong to the Company.
   */
  public async orderEvaluation(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    orderId: string,
  ): Promise<OrderHealthEvaluation | undefined> {
    const scope: ResolvedOrderHealthScope = {
      dateBasis: "order_date",
      dateFrom: null,
      dateTo: null,
      scope: "all",
      timezone: DEFAULT_TIMEZONE,
      today: "",
    };
    const row = (
      await sql<{
        orderId: string;
        orderNumber: string;
        orderDate: string;
        deliveryStatus: string;
        health: OrderFinancialHealth;
        financialClassification: FinancialVerificationClassification;
        financialCode: OrderHealthReasonCode;
        reasonCode: OrderHealthReasonCode;
        findingCodes: OrderHealthReasonCode[];
        owes: boolean;
        traderDue: string;
        amountProvable: boolean;
        receivableCount: number;
        activeCount: number;
        activeOffset: string;
        activePhysical: string;
      }>`
        ${this.evaluation(companyId, scope, orderId)}
        select e.id::text as "orderId", e.order_number as "orderNumber",
               e.order_date::text as "orderDate", e.delivery_status as "deliveryStatus",
               e.health, e.fin_class as "financialClassification",
               f.fin_code as "financialCode",
               e.reason_code as "reasonCode", e.finding_codes as "findingCodes",
               f.owes, f.trader_due::text as "traderDue", f.amount_provable as "amountProvable",
               f.receivable_count as "receivableCount", f.active_count as "activeCount",
               coalesce(f.active_offset, 0)::text as "activeOffset",
               coalesce(f.active_physical, 0)::text as "activePhysical"
          from evaluated e join findings f on f.id = e.id
      `.execute(db)
    ).rows[0];
    if (row === undefined) return undefined;
    return {
      ...toOrderHealthRow(row),
      activeOffset: row.activeOffset,
      activePhysical: row.activePhysical,
      activeReceivableCount: row.activeCount,
      amountProvable: row.amountProvable,
      financialClassification: row.financialClassification,
      financialCode: row.financialCode,
      findingCodes: row.findingCodes,
      owes: row.owes,
      receivableCount: row.receivableCount,
      traderDue: row.traderDue,
    };
  }

  // --------------------------------------------------------------- internals

  private async readOnly<T>(work: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set transaction read only`.execute(transaction);
      // Transaction-local settings (they end with this read-only transaction):
      // a statement timeout as a safety net, and no JIT -- the evaluation is
      // one wide CASE expression whose LLVM compile time (measured ~2.6 s at
      // 150k Orders) exceeds its whole execution time.
      await sql`select set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                       set_config('jit', 'off', true)`.execute(transaction);
      return work(transaction);
    });
  }

  private async context(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    input: OrderHealthScopeInput,
  ): Promise<{ context: CompanyOrderHealthContext; scope: ResolvedOrderHealthScope }> {
    const row = (
      await sql<ContextRow>`
        with tz as (
          select coalesce((
            select c.timezone from company_business_day_configurations c
             where c.company_id = ${companyId}::uuid and c.is_active
               and current_date >= c.effective_from
               and (c.effective_to is null or current_date < c.effective_to)
             order by c.effective_from desc limit 1
          ), ${DEFAULT_TIMEZONE}) as timezone
        )
        select co.id::text as id, co.code, co.name_en as "nameEn", co.status,
               co.environment,
               coalesce((select ac.accounting_enabled from accounting_configurations ac
                          where ac.company_id = co.id), false) as "accountingEnabled",
               tz.timezone,
               (now() at time zone tz.timezone)::date::text as today
          from companies co cross join tz
         where co.id = ${companyId}::uuid
      `.execute(db)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException("company_not_found", "Company not found", HttpStatus.NOT_FOUND);
    }
    const scope = resolveOrderHealthScope(input, row.today, row.timezone ?? DEFAULT_TIMEZONE);
    return {
      context: {
        accountingMode: { enabled: row.accountingEnabled },
        company: {
          code: row.code,
          environment: row.environment,
          id: row.id,
          nameEn: row.nameEn,
          status: row.status,
        },
      },
      scope,
    };
  }

  /**
   * The `evaluated` CTE: one row per Order of the Company inside the scope,
   * with `health`, `reason_code` (primary finding), `finding_codes` (every
   * non-healthy finding, most severe first) and `all_codes` (findings plus
   * the healthy classification code).
   */
  private evaluation(
    companyId: string,
    scope: ResolvedOrderHealthScope,
    orderId?: string,
  ): RawBuilder<unknown> {
    const company = sql`${companyId}::uuid`;
    const from = scope.dateFrom;
    const to = scope.dateTo;
    // ONE Order (Repair Center details / preview): every aggregate below is
    // narrowed to that Order's own records, so the statement is bounded by the
    // Order's history, never by the Company's size. Absent, the fragments are
    // empty and the company-wide statement is exactly as certified.
    const single = orderId !== undefined;
    const orderFilter = single ? sql`and o.id = ${orderId}::uuid` : sql``;
    const orderReceivableIds = sql`(
      select r2.id from trader_receivables r2
        join scoped s2 on s2.order_number = r2.source_reference
       where r2.company_id = ${company} and r2.source_type = 'service_charge')`;
    const allocationFilter = single ? sql`and a.receivable_id in ${orderReceivableIds}` : sql``;
    // The Collections allocated to this Order's receivables (their totals
    // decide COLLECTION_ALLOCATION_MISMATCH), and those receivables' credits.
    const collectionFilter = single
      ? sql`and a.collection_id in (select a2.collection_id from trader_collection_allocations a2
                                     where a2.company_id = ${company} and a2.receivable_id in ${orderReceivableIds})`
      : sql``;
    const creditFilter = single ? sql`and tc.source_receivable_id in ${orderReceivableIds}` : sql``;
    const offsetFilter = single ? sql`and x.receivable_id in ${orderReceivableIds}` : sql``;
    const settlementFilter = single
      ? sql`and s.id in (select x2.settlement_id from trader_settlement_receivable_offsets x2
                          where x2.company_id = ${company} and x2.receivable_id in ${orderReceivableIds})`
      : sql``;
    const eventFilter = single ? sql`and e.source_entity_id in (select id from scoped)` : sql``;
    const reconciliationFilter = single ? sql`and ro.order_id in (select id from scoped)` : sql``;
    // Date-scoped: only the Receivables of the Orders in scope (Order numbers
    // are unique per Company, so this join keeps exactly those). Unscoped:
    // every Receivable of the Company is needed anyway, and skipping the join
    // saves a 150k-row sort (EXPLAIN: ~1.2 s -> ~1.0 s at 150k Orders, while
    // the join makes the 30-day default ~2x faster).
    const receivablesInScope =
      from === null && to === null && !single
        ? sql``
        : sql`join scoped so on so.order_number = r.source_reference`;
    const issueCodes = sql.raw(`array[${ISSUE_REASON_CODES.map((code) => `'${code}'`).join(",")}]`);
    return sql`
      with
      vat as (
        select coalesce(cs.vat_enabled, false) as enabled, cs.vat_price_mode as price_mode,
               coalesce(cs.vat_rate, 0) as rate
          from (select 1) one
          left join company_settings cs on cs.company_id = ${company}
      ),
      accounting_now as (
        select coalesce((select ac.accounting_enabled from accounting_configurations ac
                          where ac.company_id = ${company}), false) as enabled,
               -- Was GL Accounting EVER switched ON for this Company? If never,
               -- no Order can need an Event and the per-Order history lookup
               -- below is skipped.
               exists (select 1 from accounting_configuration_history h
                        where h.company_id = ${company}
                          and (h.configuration_snapshot->>'accounting_enabled')::boolean)
                 as ever_enabled
      ),
      scoped as (
        select o.id, o.order_number, o.order_date, o.delivery_status, o.payment_condition,
               o.cod_amount, o.service_fee, o.additional_fees, o.is_free_order,
               o.trader_net_payable, o.delivered_at, o.updated_at,
               o.financial_model_version, o.vat_enabled_snapshot, o.vat_price_mode_snapshot,
               o.vat_rate_snapshot, o.total_deductions, o.service_fee_net_amount,
               o.service_fee_vat_amount, o.additional_fee_vat_amount,
               o.driver_reconciliation_status
          from orders o
         where o.company_id = ${company}
           and (${from}::date is null or o.order_date >= ${from}::date)
           and (${to}::date is null or o.order_date <= ${to}::date)
           ${orderFilter}
      ),
      -- Settlements whose offsets currently count (effective-settlement-offsets.ts).
      effective_settlements as (
        select s.id, s.trader_id from trader_settlements s
         where s.company_id = ${company} and ${effectiveSettlement("s")}
           ${settlementFilter}
      ),
      -- Confirmed Collections allocated beyond the money they received
      -- (trader-receivable-reconciliation.ts: COLLECTION_ALLOCATION_MISMATCH).
      over_allocated as (
        select a.collection_id
          from trader_collection_allocations a
          join trader_collections c on c.id = a.collection_id and c.company_id = a.company_id
         where a.company_id = ${company} and c.status = 'confirmed'
           ${collectionFilter}
         group by a.collection_id, c.amount_received
        having sum(a.amount_allocated) > c.amount_received
      ),
      physical as (
        select a.receivable_id, sum(a.amount_allocated) as amount,
               bool_or(c.trader_id <> pr.trader_id or oa.collection_id is not null) as mismatch
          from trader_collection_allocations a
          join trader_collections c on c.id = a.collection_id and c.company_id = a.company_id
          join trader_receivables pr on pr.id = a.receivable_id and pr.company_id = a.company_id
          left join over_allocated oa on oa.collection_id = a.collection_id
         where a.company_id = ${company} and c.status = 'confirmed'
           ${allocationFilter}
         group by a.receivable_id
      ),
      offsets as (
        select x.receivable_id, sum(x.amount_allocated) as amount,
               count(distinct x.settlement_id)::int as settlements,
               bool_or(es.trader_id <> orr.trader_id) as wrong_trader
          from trader_settlement_receivable_offsets x
          join effective_settlements es on es.id = x.settlement_id
          join trader_receivables orr on orr.id = x.receivable_id and orr.company_id = x.company_id
         where x.company_id = ${company}
           ${offsetFilter}
         group by x.receivable_id
      ),
      live_credits as (
        select distinct tc.source_receivable_id
          from trader_credits tc
         where tc.company_id = ${company} and tc.status <> 'cancelled' and tc.source_receivable_id is not null
           ${creditFilter}
      ),
      receivables as (
        select r.source_reference, r.created_at, r.status,
               r.original_amount_due as due, r.outstanding_amount as outstanding,
               r.amount_collected as collected,
               coalesce(p.amount, 0) as physical, coalesce(f.amount, 0) as offset_amount,
               coalesce(f.settlements, 0) as effective_settlements,
               coalesce(p.mismatch, false) as allocation_mismatch,
               coalesce(f.wrong_trader, false) as offset_wrong_trader,
               lc.source_receivable_id is not null as has_live_credit,
               r.status not in ('reversed', 'cancelled') as active
          from trader_receivables r
          ${receivablesInScope}
          left join physical p on p.receivable_id = r.id
          left join offsets f on f.receivable_id = r.id
          left join live_credits lc on lc.source_receivable_id = r.id
         where r.company_id = ${company} and r.source_type = 'service_charge'
      ),
      receivable_anomalies as (
        select rv.*,
               -- THE reconciliation decision (trader-receivable-reconciliation.ts),
               -- shared with Verify First.
               ${receivableAnomalySql({
                 allocationMismatch: sql`rv.allocation_mismatch`,
                 collected: sql`rv.collected`,
                 due: sql`rv.due`,
                 effectiveSettlements: sql`rv.effective_settlements`,
                 hasLiveCredit: sql`rv.has_live_credit`,
                 offset: sql`rv.offset_amount`,
                 offsetWrongTrader: sql`rv.offset_wrong_trader`,
                 physical: sql`rv.physical`,
                 status: sql`rv.status`,
               })} as anomaly
          from receivables rv
      ),
      receivables_by_order as (
        select source_reference,
               count(*)::int as receivable_count,
               count(*) filter (where active)::int as active_count,
               -- An actionable (ISSUE) anomaly outranks a review-only one.
               (array_agg(anomaly order by (anomaly = any(${issueAnomalyListSql()})) desc, created_at)
                  filter (where anomaly is not null))[1] as anomaly,
               max(due) filter (where active) as active_due,
               coalesce(sum(offset_amount) filter (where active), 0) as active_offset,
               coalesce(sum(physical) filter (where active), 0) as active_physical,
               coalesce(bool_or(active and physical >= due), false) as active_physically_collected,
               coalesce(bool_or(active and outstanding > 0), false) as active_outstanding,
               coalesce(bool_or(active and physical > 0 and offset_amount > 0 and physical + offset_amount >= due), false)
                 as active_mixed_settled
          from receivable_anomalies
         group by source_reference
      ),
      order_events as (
        select e.source_entity_id as order_id,
               bool_or(e.processing_status in ('failed', 'blocked_configuration')) as failed,
               bool_or(e.processing_status in ('posted', 'reversed', 'ignored_duplicate',
                                               'ignored_no_accounting_required')) as settled
          from accounting_events e
         where e.company_id = ${company} and e.source_entity_type = 'order'
           ${eventFilter}
         group by e.source_entity_id
      ),
      effective_reconciliations as (
        select ro.order_id
          from driver_reconciliation_orders ro
          join driver_reconciliations dr on dr.id = ro.reconciliation_id and dr.company_id = ro.company_id
         where ro.company_id = ${company} and dr.status = 'confirmed' and dr.reversal_of_id is null
           ${reconciliationFilter}
           and not exists (
             select 1 from driver_reconciliations rv
              where rv.company_id = dr.company_id and rv.reversal_of_id = dr.id)
         group by ro.order_id
      ),
      -- MATERIALIZED: computed once. Inlined, the wide CASE expressions below
      -- were re-evaluated per reference (EXPLAIN at 150k Orders).
      checked as materialized (
        select o.id, o.order_number, o.order_date, o.delivery_status,
               -- THE expected Trader receivable amount (historical, Prompt 4).
               ed.due > 0 as owes,
               ed.due as trader_due,
               hp.provable as amount_provable,
               coalesce(rb.receivable_count, 0) as receivable_count,
               coalesce(rb.active_count, 0) as active_count,
               rb.anomaly, rb.active_offset, rb.active_physical, rb.active_due,
               coalesce(rb.active_physically_collected, false) as active_physically_collected,
               coalesce(rb.active_outstanding, false) as active_outstanding,
               coalesce(rb.active_mixed_settled, false) as active_mixed_settled,
               -- Accounting: an Order delivered while GL Accounting was ON
               -- must have an Event (same rule as the Integrity Checker).
               -- Delivered while OFF, no Event is the correct state.
               (case
                  when not accounting_now.ever_enabled then false
                  when o.delivery_status in ('delivered', 'closed') and not o.is_free_order
                       and o.trader_net_payable > 0 and ev.order_id is null
                    then accounting_enabled_at(${company}, coalesce(o.delivered_at, o.updated_at))
                  else false
                end) as missing_accounting_event,
               (accounting_now.enabled and coalesce(ev.failed, false)
                and not coalesce(ev.settled, false)) as accounting_event_failed,
               (o.driver_reconciliation_status = 'reconciled' and er.order_id is null)
                 as cash_reconciled_without_reconciliation,
               (o.driver_reconciliation_status <> 'reconciled' and er.order_id is not null)
                 as cash_reconciliation_not_reflected
          from scoped o
          cross join vat
          cross join accounting_now
          -- The historical rule, evaluated ONCE per Order.
          cross join lateral (select ${historicalAmountProvableSql()} as provable) hp
          cross join lateral (select ${expectedTraderReceivableSql(sql`hp.provable`)} as due) ed
          left join receivables_by_order rb on rb.source_reference = o.order_number
          left join order_events ev on ev.order_id = o.id
          left join effective_reconciliations er on er.order_id = o.id
      ),
      classified as materialized (
        select c.*,
               -- THE Trader receivable decision. Verify First
               -- (OrderMaintenanceService.financialVerification) reads this
               -- evaluation; it has no decision chain of its own.
               case
                 when c.anomaly is not null then
                   case when c.anomaly = any(${issueAnomalyListSql()}) then 'RECEIVABLE_INCONSISTENT'
                        else 'NEEDS_REVIEW' end
                 when c.active_count > 1 then 'NEEDS_REVIEW'
                 when not c.owes and c.active_count > 0 then 'NEEDS_REVIEW'
                 when not c.owes then 'NO_TRADER_RECEIVABLE_REQUIRED'
                 when c.active_count = 1 and c.active_due <> c.trader_due then
                   case when c.amount_provable then 'RECEIVABLE_INCONSISTENT' else 'NEEDS_REVIEW' end
                 when c.active_physically_collected then 'ALREADY_PHYSICALLY_COLLECTED'
                 when c.active_outstanding then 'HEALTHY_ACTIVE_RECEIVABLE'
                 when c.active_mixed_settled then 'ALREADY_PHYSICALLY_COLLECTED'
                 when c.active_count > 0 and c.active_offset > 0 and c.active_physical = 0
                   then 'OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION'
                 when c.receivable_count > 0 and c.active_count = 0 then 'REVERSED_NEEDS_REPAIR'
                 when c.receivable_count = 0 then 'MISSING_RECEIVABLE'
                 else 'NEEDS_REVIEW'
               end as fin_class,
               case
                 when c.anomaly is not null then c.anomaly
                 when c.active_count > 1 then 'MULTIPLE_ACTIVE_RECEIVABLES'
                 when not c.owes and c.active_count > 0 then 'RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE'
                 when not c.owes then 'NO_TRADER_RECEIVABLE_REQUIRED'
                 when c.active_count = 1 and c.active_due <> c.trader_due then
                   case when c.amount_provable then 'RECEIVABLE_AMOUNT_MISMATCH' else 'RECEIVABLE_AMOUNT_NOT_PROVABLE' end
                 when c.active_physically_collected then 'ALREADY_PHYSICALLY_COLLECTED'
                 when c.active_outstanding then 'HEALTHY_ACTIVE_RECEIVABLE'
                 when c.active_mixed_settled then 'SETTLED_BY_COLLECTION_AND_OFFSET'
                 when c.active_count > 0 and c.active_offset > 0 and c.active_physical = 0
                   then 'OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION'
                 when c.receivable_count > 0 and c.active_count = 0 then 'REVERSED_NEEDS_REPAIR'
                 when c.receivable_count = 0 then 'MISSING_RECEIVABLE'
                 else 'RECEIVABLE_STATE_INCONSISTENT'
               end as fin_code
          from checked c
      ),
      findings as (
        select k.*,
               -- Most severe first: actionable receivable gaps, accounting
               -- failures, then the review-only findings.
               array_remove(array[
                 case when k.fin_class in ('MISSING_RECEIVABLE', 'REVERSED_NEEDS_REPAIR', 'RECEIVABLE_INCONSISTENT')
                      then k.fin_code end,
                 case when k.missing_accounting_event then 'ORDER_MISSING_ACCOUNTING_EVENT' end,
                 case when k.accounting_event_failed then 'ACCOUNTING_EVENT_FAILED' end,
                 case when k.fin_class = 'NEEDS_REVIEW' then k.fin_code end,
                 case when k.cash_reconciled_without_reconciliation
                      then 'DRIVER_CASH_RECONCILED_WITHOUT_RECONCILIATION' end,
                 case when k.cash_reconciliation_not_reflected
                      then 'DRIVER_CASH_RECONCILIATION_NOT_REFLECTED' end
               ]::text[], null) as finding_codes
          from classified k
      ),
      evaluated as (
        select f.id, f.order_number, f.order_date, f.delivery_status, f.fin_class,
               f.finding_codes,
               coalesce(f.finding_codes[1], f.fin_code) as reason_code,
               case
                 when cardinality(f.finding_codes) = 0 then 'HEALTHY'
                 when f.finding_codes[1] = any(${issueCodes}::text[]) then 'ISSUE'
                 else 'REVIEW'
               end as health,
               f.finding_codes || array[f.fin_code]::text[] as all_codes
          from findings f
      )
    `;
  }
}

function toOrderHealthRow(row: {
  orderId: string;
  orderNumber: string;
  orderDate: string;
  deliveryStatus: string;
  health: OrderFinancialHealth;
  financialClassification: FinancialVerificationClassification;
  reasonCode: OrderHealthReasonCode;
  findingCodes: OrderHealthReasonCode[];
}): OrderHealthRow {
  const definition: ReasonDefinition = ORDER_HEALTH_REASONS[row.reasonCode];
  return {
    additionalReasonCodes: row.findingCodes.filter((code) => code !== row.reasonCode),
    classification: definition.classification ?? row.financialClassification,
    deliveryStatus: row.deliveryStatus,
    health: row.health,
    orderDate: row.orderDate,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    reason: definition.reason,
    reasonCode: row.reasonCode,
    recommendedAction: definition.recommendedAction,
  };
}
