import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DriverCollectionPdfService } from "../operations/driver-collection-pdf.service.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  buildPayrollPaymentReportHtml,
  buildPayrollRegisterHtml,
  buildPayslipHtml,
  payrollFooter,
} from "./payroll-report-html.js";
import type {
  PayrollPaymentReportData,
  PayrollRegisterReportData,
  PayrollReportCompany,
  PayrollReportLanguage,
  PayslipReportData,
} from "./payroll-report.types.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";

@Injectable()
export class PayrollReportService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async payslipData(lineId: string): Promise<PayslipReportData> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const row = await sql<{
      approvedBy: string | null;
      basicSalary: string;
      department: string | null;
      driverCommission: string;
      employeeName: string;
      employeeNameAr: string | null;
      employeeNumber: string;
      employmentType: string | null;
      grossEarnings: string;
      netSalary: string;
      outstanding: string;
      paid: string;
      payrollMonth: string;
      periodReference: string;
      preparedBy: string | null;
      reversalReason: string | null;
      status: string;
      totalDeductions: string;
      payslipReference: string;
    }>`
      select l.payroll_number as "payslipReference",
             l.employee_name_snapshot as "employeeName",
             l.employee_name_ar_snapshot as "employeeNameAr",
             l.employee_number_snapshot as "employeeNumber",
             l.employment_type_snapshot as "employmentType",
             l.department_snapshot as department,
             l.basic_salary_snapshot::text as "basicSalary",
             l.employee_driver_commission::text as "driverCommission",
             l.gross_earnings::text as "grossEarnings",
             (l.deduction_adjustments_total+l.advances)::text as "totalDeductions",
             l.net_salary::text as "netSalary", l.amount_paid::text as paid,
             l.outstanding_amount::text as outstanding, l.status,
             l.reversal_reason as "reversalReason",
             p.period_reference as "periodReference",
             to_char(p.payroll_month,'YYYY-MM') as "payrollMonth",
             calculator.username as "preparedBy", approver.username as "approvedBy"
        from payroll_entries l
        join payroll_periods p on p.id=l.payroll_period_id and p.company_id=l.company_id
        left join accounts calculator on calculator.id=l.calculated_by_account_id
          and calculator.company_id=l.company_id
        left join accounts approver on approver.id=l.approved_by_account_id
          and approver.company_id=l.company_id
       where l.id=${lineId}::uuid and l.company_id=${companyId}::uuid
    `.execute(this.database);
    const header = row.rows[0];
    if (header === undefined) {
      throw new ApplicationException(
        "payroll_line_not_found",
        "The Payroll line was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (["draft", "calculated"].includes(header.status)) {
      throw new ApplicationException(
        "payroll_report_not_available",
        "A Payslip is available only after Payroll approval",
        HttpStatus.CONFLICT,
      );
    }
    const allowances = await sql<PayslipReportData["allowances"][number]>`
      select allowance_code_snapshot as code, allowance_name_snapshot as "nameEn",
             allowance_name_ar_snapshot as "nameAr", amount::text as amount
        from payroll_line_allowances
       where company_id=${companyId}::uuid and payroll_line_id=${lineId}::uuid
       order by allowance_code_snapshot, id
    `.execute(this.database);
    const adjustments = await sql<PayslipReportData["adjustments"][number]>`
      select adjustment_type as type, direction, amount::text as amount, reason
        from payroll_adjustments
       where company_id=${companyId}::uuid and payroll_line_id=${lineId}::uuid
         and status='active'
       order by created_at, id
    `.execute(this.database);
    const payments = await sql<{
      acknowledgementType: string;
      amount: string;
      cashVoucherReference: string;
      notes: string | null;
      paidBy: string;
      paymentDate: string;
    }>`
      select a.allocated_amount::text as amount,
             p.payment_date::text as "paymentDate",
             p.cash_voucher_reference as "cashVoucherReference",
             p.acknowledgement_type as "acknowledgementType",
             p.notes, payer.username as "paidBy"
        from payroll_payment_allocations a
        join payroll_payments p on p.id=a.payroll_payment_id and p.company_id=a.company_id
        join accounts payer on payer.id=p.paid_by_account_id and payer.company_id=p.company_id
       where a.company_id=${companyId}::uuid and a.payroll_line_id=${lineId}::uuid
         and a.reversed_at is null and p.status='confirmed'
       order by p.created_at, a.allocation_order
    `.execute(this.database);
    const latest = payments.rows.at(-1);
    const previouslyPaid = payments.rows
      .slice(0, -1)
      .reduce((total, payment) => total.plus(payment.amount), new Decimal(0));
    return {
      adjustments: adjustments.rows,
      allowances: allowances.rows,
      company: await this.company(),
      generatedAt: this.generatedAt(),
      header,
      payment: {
        acknowledgementType: latest?.acknowledgementType ?? null,
        amountPaidNow: latest?.amount ?? "0.00",
        cashVoucherReference: latest?.cashVoucherReference ?? null,
        notes: latest?.notes ?? null,
        paidBy: latest?.paidBy ?? null,
        paymentDate: latest?.paymentDate ?? null,
        previouslyPaid: previouslyPaid.toFixed(2),
      },
    };
  }

  public async registerData(periodId: string): Promise<PayrollRegisterReportData> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const period = await sql<PayrollRegisterReportData["header"] & PayrollRegisterReportData["summary"]>`
      select p.period_reference as "periodReference",
             p.period_start::text as "periodStart", p.period_end::text as "periodEnd",
             p.status, calculator.username as "preparedBy", approver.username as "approvedBy",
             p.total_employees as "totalEmployees",
             (select count(*)::integer from payroll_entries held
               where held.company_id=p.company_id and held.payroll_period_id=p.id
                 and held.status='held') as "heldEmployees",
             p.total_basic_salary::text as "totalBasicSalary",
             p.total_allowances::text as "totalAllowances",
             p.total_employee_driver_commission::text as "totalDriverCommission",
             p.total_earning_adjustments::text as "totalEarningAdjustments",
             p.total_deductions::text as "totalDeductions",
             p.total_net_salary::text as "totalNetSalary",
             p.total_paid::text as "totalPaid",
             p.total_outstanding::text as "totalOutstanding"
        from payroll_periods p
        left join accounts calculator on calculator.id=p.calculated_by_account_id
          and calculator.company_id=p.company_id
        left join accounts approver on approver.id=p.approved_by_account_id
          and approver.company_id=p.company_id
       where p.id=${periodId}::uuid and p.company_id=${companyId}::uuid
    `.execute(this.database);
    const resolved = period.rows[0];
    if (resolved === undefined) {
      throw new ApplicationException(
        "payroll_period_not_found",
        "The Payroll period was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (["draft", "calculated"].includes(resolved.status)) {
      throw new ApplicationException(
        "payroll_report_not_available",
        "The Payroll Register is available only after Payroll approval",
        HttpStatus.CONFLICT,
      );
    }
    const lines = await sql<PayrollRegisterReportData["lines"][number]>`
      select employee_number_snapshot as "employeeNumber",
             employee_name_snapshot as "employeeName",
             employment_type_snapshot as "employmentType",
             basic_salary_snapshot::text as "basicSalary",
             allowance_total::text as allowances,
             employee_driver_commission::text as "driverCommission",
             earning_adjustments_total::text as "earningAdjustments",
             (deduction_adjustments_total+advances)::text as deductions,
             net_salary::text as "netSalary", amount_paid::text as paid,
             outstanding_amount::text as outstanding, status
        from payroll_entries
       where company_id=${companyId}::uuid and payroll_period_id=${periodId}::uuid
       order by employee_number_snapshot, id
    `.execute(this.database);
    return {
      company: await this.company(),
      generatedAt: this.generatedAt(),
      header: {
        approvedBy: resolved.approvedBy,
        periodEnd: resolved.periodEnd,
        periodReference: resolved.periodReference,
        periodStart: resolved.periodStart,
        preparedBy: resolved.preparedBy,
        status: resolved.status,
      },
      lines: lines.rows,
      summary: {
        heldEmployees: resolved.heldEmployees,
        totalAllowances: resolved.totalAllowances,
        totalBasicSalary: resolved.totalBasicSalary,
        totalDeductions: resolved.totalDeductions,
        totalDriverCommission: resolved.totalDriverCommission,
        totalEarningAdjustments: resolved.totalEarningAdjustments,
        totalEmployees: resolved.totalEmployees,
        totalNetSalary: resolved.totalNetSalary,
        totalOutstanding: resolved.totalOutstanding,
        totalPaid: resolved.totalPaid,
      },
    };
  }

  public async paymentData(paymentId: string): Promise<PayrollPaymentReportData> {
    this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const payment = await sql<PayrollPaymentReportData["header"]>`
      select pay.payment_number as "paymentNumber",
             p.period_reference as "periodReference",
             pay.payment_date::text as "paymentDate",
             pay.total_amount::text as "totalAmount",
             pay.cash_voucher_reference as "cashVoucherReference",
             pay.external_reference as "externalReference",
             pay.acknowledgement_type as "acknowledgementType",
             pay.notes, pay.status, payer.username as "paidBy",
             pay.reversed_at::text as "reversedAt",
             pay.reversal_reason as "reversalReason", reverser.username as "reversedBy"
        from payroll_payments pay
        join payroll_periods p on p.id=pay.payroll_period_id and p.company_id=pay.company_id
        join accounts payer on payer.id=pay.paid_by_account_id and payer.company_id=pay.company_id
        left join accounts reverser on reverser.id=pay.reversed_by_account_id
          and reverser.company_id=pay.company_id
       where pay.id=${paymentId}::uuid and pay.company_id=${companyId}::uuid
    `.execute(this.database);
    const header = payment.rows[0];
    if (header === undefined) {
      throw new ApplicationException(
        "payroll_payment_not_found",
        "The Payroll payment was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const allocations = await sql<PayrollPaymentReportData["allocations"][number]>`
      select l.employee_number_snapshot as "employeeNumber",
             l.employee_name_snapshot as "employeeName",
             l.net_salary::text as "netSalary", l.status as "lineStatus",
             a.allocated_amount::text as "amountPaidNow",
             coalesce((
               select sum(prior.allocated_amount)
                 from payroll_payment_allocations prior
                 join payroll_payments prior_pay
                   on prior_pay.id=prior.payroll_payment_id
                  and prior_pay.company_id=prior.company_id
                where prior.company_id=a.company_id
                  and prior.payroll_line_id=a.payroll_line_id
                  and prior_pay.created_at < pay.created_at
                  and (prior.reversed_at is null or prior.reversed_at > pay.created_at)
             ),0)::text as "previouslyPaid",
             greatest(0, l.net_salary-coalesce((
               select sum(prior.allocated_amount)
                 from payroll_payment_allocations prior
                 join payroll_payments prior_pay
                   on prior_pay.id=prior.payroll_payment_id
                  and prior_pay.company_id=prior.company_id
                where prior.company_id=a.company_id
                  and prior.payroll_line_id=a.payroll_line_id
                  and prior_pay.created_at < pay.created_at
                  and (prior.reversed_at is null or prior.reversed_at > pay.created_at)
             ),0)-a.allocated_amount)::text as "remainingOutstanding"
        from payroll_payment_allocations a
        join payroll_payments pay on pay.id=a.payroll_payment_id and pay.company_id=a.company_id
        join payroll_entries l on l.id=a.payroll_line_id and l.company_id=a.company_id
       where a.company_id=${companyId}::uuid and a.payroll_payment_id=${paymentId}::uuid
       order by a.allocation_order
    `.execute(this.database);
    return {
      allocations: allocations.rows,
      company: await this.company(),
      generatedAt: this.generatedAt(),
      header,
      summary: {
        employeeCount: new Set(allocations.rows.map((line) => line.employeeNumber)).size,
        totalPayment: header.totalAmount,
        totalRemainingOutstanding: allocations.rows
          .reduce((total, line) => total.plus(line.remainingOutstanding), new Decimal(0))
          .toFixed(2),
      },
    };
  }

  public async payslipPdf(
    lineId: string,
    language: PayrollReportLanguage,
    correlationId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    return this.render(
      "payroll.payslip.pdf_generated",
      lineId,
      "payroll_line",
      language,
      await this.payslipData(lineId),
      (data) => buildPayslipHtml(data, language),
      (data) =>
        `Payslip-${this.safe(data.header.periodReference)}-${this.safe(data.header.employeeNumber)}.pdf`,
      correlationId,
    );
  }

  public async registerPdf(
    periodId: string,
    language: PayrollReportLanguage,
    correlationId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    return this.render(
      "payroll.register.pdf_generated",
      periodId,
      "payroll_period",
      language,
      await this.registerData(periodId),
      (data) => buildPayrollRegisterHtml(data, language),
      (data) => `Payroll-Register-${this.safe(data.header.periodReference)}.pdf`,
      correlationId,
    );
  }

  public async paymentPdf(
    paymentId: string,
    language: PayrollReportLanguage,
    correlationId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    return this.render(
      "payroll.payment_report.pdf_generated",
      paymentId,
      "payroll_payment",
      language,
      await this.paymentData(paymentId),
      (data) => buildPayrollPaymentReportHtml(data, language),
      (data) => `Payroll-Payment-${this.safe(data.header.paymentNumber)}.pdf`,
      correlationId,
    );
  }

  private async render<T>(
    action: string,
    subjectId: string,
    subjectType: string,
    language: PayrollReportLanguage,
    data: T,
    html: (data: T) => string,
    filename: (data: T) => string,
    correlationId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    this.support.assertPermission("payroll.view");
    this.support.assertPermission("reports.export");
    const { actorId, companyId } = this.support.context();
    const bytes = await this.pdf.renderPdf(html(data), payrollFooter(language));
    await this.history.audit(this.database, {
      action,
      actorId,
      after: { language },
      companyId,
      correlationId,
      subjectId,
      subjectType,
    });
    return { bytes, filename: filename(data) };
  }

  private async company(): Promise<PayrollReportCompany> {
    const branding = await this.companyProfile.branding();
    const logoDataUri = branding.hasLogo
      ? await this.companyProfile
          .logoContent()
          .then((logo) => `data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`)
          .catch(() => null)
      : null;
    return {
      logoDataUri,
      nameAr: branding.nameAr,
      nameEn: branding.nameEn,
      subtitleAr: branding.subtitleAr,
      subtitleEn: branding.subtitleEn,
      telephone: branding.telephone,
    };
  }

  private generatedAt(): string {
    return `${new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date())} (UAE)`;
  }

  private safe(value: string): string {
    return value.replaceAll(/[^A-Za-z0-9-]/g, "") || "Payroll";
  }
}
