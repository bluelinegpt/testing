export type PayrollReportLanguage = "ar" | "en";

export interface PayrollReportCompany {
  readonly logoDataUri: string | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  readonly telephone: string | null;
}

export interface PayslipReportData {
  readonly adjustments: readonly {
    readonly amount: string;
    readonly direction: "deduction" | "earning";
    readonly reason: string;
    readonly type: string;
  }[];
  readonly allowances: readonly {
    readonly amount: string;
    readonly code: string;
    readonly nameAr: string | null;
    readonly nameEn: string;
  }[];
  readonly company: PayrollReportCompany;
  readonly generatedAt: string;
  readonly header: {
    readonly approvedBy: string | null;
    readonly basicSalary: string;
    readonly department: string | null;
    readonly driverCommission: string;
    readonly employeeName: string;
    readonly employeeNameAr: string | null;
    readonly employeeNumber: string;
    readonly employmentType: string | null;
    readonly grossEarnings: string;
    readonly netSalary: string;
    readonly outstanding: string;
    readonly paid: string;
    readonly payrollMonth: string;
    readonly periodReference: string;
    readonly preparedBy: string | null;
    readonly reversalReason: string | null;
    readonly status: string;
    readonly totalDeductions: string;
    readonly payslipReference: string;
  };
  readonly payment: {
    readonly acknowledgementType: string | null;
    readonly amountPaidNow: string;
    readonly cashVoucherReference: string | null;
    readonly notes: string | null;
    readonly paidBy: string | null;
    readonly paymentDate: string | null;
    readonly previouslyPaid: string;
  };
}

export interface PayrollRegisterReportData {
  readonly company: PayrollReportCompany;
  readonly generatedAt: string;
  readonly header: {
    readonly approvedBy: string | null;
    readonly periodEnd: string;
    readonly periodReference: string;
    readonly periodStart: string;
    readonly preparedBy: string | null;
    readonly status: string;
  };
  readonly lines: readonly {
    readonly allowances: string;
    readonly basicSalary: string;
    readonly deductions: string;
    readonly driverCommission: string;
    readonly earningAdjustments: string;
    readonly employeeName: string;
    readonly employeeNumber: string;
    readonly employmentType: string | null;
    readonly netSalary: string;
    readonly outstanding: string;
    readonly paid: string;
    readonly status: string;
  }[];
  readonly summary: {
    readonly heldEmployees: number;
    readonly totalAllowances: string;
    readonly totalBasicSalary: string;
    readonly totalDeductions: string;
    readonly totalDriverCommission: string;
    readonly totalEarningAdjustments: string;
    readonly totalEmployees: number;
    readonly totalNetSalary: string;
    readonly totalOutstanding: string;
    readonly totalPaid: string;
  };
}

export interface PayrollPaymentReportData {
  readonly allocations: readonly {
    readonly amountPaidNow: string;
    readonly employeeName: string;
    readonly employeeNumber: string;
    readonly lineStatus: string;
    readonly netSalary: string;
    readonly previouslyPaid: string;
    readonly remainingOutstanding: string;
  }[];
  readonly company: PayrollReportCompany;
  readonly generatedAt: string;
  readonly header: {
    readonly acknowledgementType: string;
    readonly cashVoucherReference: string;
    readonly externalReference: string | null;
    readonly notes: string | null;
    readonly paidBy: string;
    readonly paymentDate: string;
    readonly paymentNumber: string;
    readonly periodReference: string;
    readonly reversalReason: string | null;
    readonly reversedAt: string | null;
    readonly reversedBy: string | null;
    readonly status: string;
    readonly totalAmount: string;
  };
  readonly summary: {
    readonly employeeCount: number;
    readonly totalPayment: string;
    readonly totalRemainingOutstanding: string;
  };
}
