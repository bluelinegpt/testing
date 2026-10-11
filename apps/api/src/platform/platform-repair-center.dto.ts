import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateBy,
  type ValidationOptions,
} from "class-validator";

import {
  ORDER_HEALTH_DATE_SCOPES,
  ORDER_HEALTH_FILTERS,
  ORDER_HEALTH_MAX_PAGE_SIZE,
  ORDER_HEALTH_REASON_CODES,
  type OrderHealthDateScope,
  type OrderHealthFilter,
  type OrderHealthReasonCode,
} from "../operations/company-order-health.service.js";
import { accountingEventTypes } from "../accounting/accounting.constants.js";
import {
  ACCOUNTING_HEALTH_MAX_PAGE_SIZE,
  ACCOUNTING_HEALTH_STATUSES,
  ACCOUNTING_INTEGRITY_KINDS,
  ACCOUNTING_TRIAGES,
  type AccountingIntegrityKind,
  type AccountingHealthStatusFilter,
  type AccountingTriage,
} from "../accounting/platform-accounting-health.service.js";
import { PAYROLL_CAPABILITIES, PAYROLL_HEALTH_MAX_PAGE_SIZE } from "../operations/payroll-repair.service.js";
import { REPAIR_CAPABILITIES } from "../operations/repair-capability.registry.js";
import {
  REPAIR_HISTORY_MAX_PAGE_SIZE,
  REPAIR_HISTORY_RESULTS,
  type RepairHistoryResult,
} from "../operations/repair-history.service.js";

/**
 * Query contracts of the Platform Repair Center (read-only).
 *
 * The global validation pipe runs with `whitelist` + `forbidNonWhitelisted`,
 * so an unknown parameter -- a `companyId` in the query string, say -- is
 * rejected. The Company is taken ONLY from the `:companyId` route parameter,
 * re-resolved by `PlatformTargetCompanyGuard`.
 */

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const deliveryStatuses = [
  "new",
  "in_branch",
  "assigned_to_driver",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
  "collect_order",
] as const;

const isoDate = /^\d{4}-\d{2}-\d{2}$/u;

export class OrderHealthScopeQueryDto {
  @IsOptional()
  @IsIn(ORDER_HEALTH_DATE_SCOPES)
  public scope?: OrderHealthDateScope;

  @IsOptional()
  @Matches(isoDate, { message: "dateFrom must be YYYY-MM-DD" })
  public dateFrom?: string;

  @IsOptional()
  @Matches(isoDate, { message: "dateTo must be YYYY-MM-DD" })
  public dateTo?: string;
}

export class OrderHealthListQueryDto extends OrderHealthScopeQueryDto {
  @IsOptional()
  @IsIn(ORDER_HEALTH_FILTERS)
  public health?: OrderHealthFilter;

  /** Order number (or part of one). Never a customer field. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  public search?: string;

  @IsOptional()
  @IsIn(deliveryStatuses)
  public deliveryStatus?: (typeof deliveryStatuses)[number];

  @IsOptional()
  @IsIn(ORDER_HEALTH_REASON_CODES)
  public reasonCode?: OrderHealthReasonCode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ORDER_HEALTH_MAX_PAGE_SIZE)
  public pageSize?: number;
}

/**
 * Repair plan preview parameters. Only WHICH recomputed finding to preview may
 * be chosen; health, state and amounts are never accepted from the browser.
 */
export class RepairPreviewRequestDto {
  @IsOptional()
  @IsIn(ORDER_HEALTH_REASON_CODES)
  public reasonCode?: OrderHealthReasonCode;
}

// Phase 5 Prompt 1: the Payroll period capabilities (executed by their own route).
const CAPABILITY_CODES = [
  ...REPAIR_CAPABILITIES.map((capability) => capability.capabilityCode),
  ...PAYROLL_CAPABILITIES,
];

/** At most 10 named string inputs, each at most 500 characters. */
function IsRepairInputs(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: "isRepairInputs",
      validator: {
        defaultMessage: () => "inputs must map at most 10 input names to strings of at most 500 characters",
        validate: (value: unknown) =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          Object.keys(value).length <= 10 &&
          Object.entries(value).every(
            ([name, item]) =>
              /^[A-Za-z][A-Za-z0-9_]{0,40}$/u.test(name) && typeof item === "string" && item.length <= 500,
          ),
      },
    },
    options,
  );
}

/**
 * Execute ONE certified repair (Prompt 3). The browser names only WHICH
 * recomputed finding and registered capability, the fingerprint it reviewed,
 * a reason, the capability's declared inputs and an idempotency key. No
 * table, field, status, amount, SQL or handler is accepted; the server
 * recomputes and re-proves READY before running anything.
 */
export class RepairExecutionRequestDto {
  @IsString()
  @Matches(/^fnd_[0-9a-f]{24}$/u)
  public findingId!: string;

  @IsIn(CAPABILITY_CODES)
  public capabilityCode!: string;

  @IsString()
  @Matches(/^(rcv1|prv1):[0-9a-f]{64}$/u)
  public previewVersion!: string;

  @Transform(trim)
  @IsString()
  @Length(3, 500)
  public reason!: string;

  @IsOptional()
  @IsObject()
  @IsRepairInputs()
  public inputs?: Record<string, string>;

  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{16,128}$/u)
  public idempotencyKey!: string;
}

/**
 * Accounting Health list filters (Prompt 4). Every filter is applied in
 * PostgreSQL; unknown parameters are rejected by the global pipe.
 */
export class AccountingHealthQueryDto {
  @IsOptional()
  @IsIn(ACCOUNTING_HEALTH_STATUSES)
  public status?: AccountingHealthStatusFilter;

  @IsOptional()
  @IsIn(accountingEventTypes)
  public eventType?: string;

  @IsOptional()
  @IsIn(ACCOUNTING_TRIAGES)
  public repairability?: AccountingTriage;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  public reference?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  public dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  public dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ACCOUNTING_HEALTH_MAX_PAGE_SIZE)
  public pageSize?: number;
}

/** Accounting integrity / missing-event findings (Phase 4 Prompt 1); paginated in PostgreSQL. */
export class AccountingIntegrityQueryDto {
  @IsOptional()
  @IsIn(ACCOUNTING_INTEGRITY_KINDS)
  public kind?: AccountingIntegrityKind;

  @IsOptional()
  @IsIn(accountingEventTypes)
  public eventType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ACCOUNTING_HEALTH_MAX_PAGE_SIZE)
  public pageSize?: number;
}

/** Payroll Health findings (Phase 5 Prompt 1); paginated in PostgreSQL. */
export class PayrollHealthQueryDto {
  @IsOptional()
  @IsIn(["attention", "all"])
  public status?: "attention" | "all";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYROLL_HEALTH_MAX_PAGE_SIZE)
  public pageSize?: number;
}

/** Accounting recovery preview takes no parameters: everything is recomputed. */
export class AccountingRecoveryPreviewRequestDto {}

/** Repair Center History filters (Prompt 5); paginated in PostgreSQL. */
export class RepairHistoryQueryDto {
  @IsOptional()
  @IsIn(REPAIR_HISTORY_RESULTS)
  public result?: RepairHistoryResult;

  @IsOptional()
  @IsIn(CAPABILITY_CODES)
  public capabilityCode?: string;

  @IsOptional()
  @IsIn(["order", "trader_receivable", "accounting_event", "payroll_period"])
  public entityType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REPAIR_HISTORY_MAX_PAGE_SIZE)
  public pageSize?: number;
}
