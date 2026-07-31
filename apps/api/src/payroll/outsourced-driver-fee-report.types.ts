import type { PayrollReportCompany, PayrollReportLanguage } from "./payroll-report.types.js";

export interface DriverFeeReportBase {
  readonly company: PayrollReportCompany;
  readonly generatedAt: string;
}

export interface DriverEarningsStatementData extends DriverFeeReportBase {
  readonly driver: { readonly code: string; readonly id: string; readonly name: string };
  readonly from: string;
  readonly to: string;
  readonly summary: {
    readonly accrualCount: number;
    readonly closingOutstanding: string;
    readonly collectionOffsets: string;
    readonly feesEarned: string;
    readonly openingOutstanding: string;
    readonly recoveryRequired: string;
    readonly reversedPayments: string;
    readonly separatePayments: string;
  };
  readonly lines: readonly Record<string, unknown>[];
  readonly warnings: readonly string[];
}

export interface OutstandingDriverFeesReportData extends DriverFeeReportBase {
  readonly asOf: string;
  readonly summary: Record<string, string | number | null>;
  readonly lines: readonly Record<string, unknown>[];
}

export interface DailyDriverFeeAccrualReportData extends DriverFeeReportBase {
  readonly from: string;
  readonly to: string;
  readonly summary: Record<string, string | number>;
  readonly lines: readonly Record<string, unknown>[];
}

export interface DriverFeePaymentReceiptData extends DriverFeeReportBase {
  readonly header: Record<string, unknown>;
  readonly allocations: readonly Record<string, unknown>[];
  readonly summary: Record<string, string | number | null>;
}

export type DriverFeeReportLanguage = PayrollReportLanguage;
