import type {
  PayrollPaymentReportData,
  PayrollRegisterReportData,
  PayrollReportCompany,
  PayrollReportLanguage,
  PayslipReportData,
} from "./payroll-report.types.js";

const labels = {
  ar: {
    acknowledgement: "نوع الإقرار",
    allowances: "البدلات",
    amountPaidNow: "المبلغ المدفوع الآن",
    approvedBy: "اعتمد بواسطة",
    basicSalary: "الراتب الأساسي",
    cashReceived: "إقرار استلام النقد",
    companyAuthorization: "اعتماد الشركة",
    deductions: "الخصومات",
    department: "القسم",
    driverCommission: "عمولة السائق الموظف",
    earningAdjustments: "تعديلات الاستحقاقات",
    earnings: "الاستحقاقات",
    employee: "الموظف",
    employeeCount: "عدد الموظفين",
    employeeNumber: "رقم الموظف",
    employeeSignature: "توقيع الموظف",
    employmentType: "نوع التوظيف",
    externalReference: "المرجع الخارجي",
    generatedAt: "تاريخ ووقت الإنشاء",
    grossEarnings: "إجمالي الاستحقاقات",
    heldEmployees: "الموظفون الموقوفة رواتبهم",
    line: "#",
    netSalary: "صافي الراتب",
    notes: "ملاحظات",
    outstanding: "المبلغ المستحق",
    paid: "المدفوع",
    paidBy: "دفع بواسطة",
    paymentDate: "تاريخ الدفع",
    paymentNumber: "رقم الدفعة",
    paymentReport: "تقرير دفع الرواتب",
    paymentStatus: "حالة الدفع",
    payrollMonth: "شهر الرواتب",
    payrollPeriod: "فترة الرواتب",
    payrollRegister: "سجل رواتب الموظفين",
    payslip: "قسيمة راتب الموظف",
    payslipReference: "مرجع قسيمة الراتب",
    periodDates: "بداية ونهاية الفترة",
    preparedBy: "أعد بواسطة",
    previouslyPaid: "المدفوع سابقاً",
    reason: "السبب",
    recipientAcknowledgement: "إقرار الموظف / المستلم",
    remainingOutstanding: "المبلغ المتبقي",
    reversalReason: "سبب العكس",
    reversedAt: "تاريخ العكس",
    reversedBy: "عكس بواسطة",
    status: "الحالة",
    totalAllowances: "إجمالي البدلات",
    totalBasicSalary: "إجمالي الراتب الأساسي",
    totalDeductions: "إجمالي الخصومات",
    totalDriverCommission: "إجمالي عمولة السائق",
    totalEarningAdjustments: "إجمالي تعديلات الاستحقاقات",
    totalEmployees: "إجمالي الموظفين",
    totalNetSalary: "إجمالي صافي الرواتب",
    totalOutstanding: "إجمالي المستحق",
    totalPaid: "إجمالي المدفوع",
    totalPayment: "إجمالي الدفعة",
    voucher: "مرجع سند الصرف النقدي",
  },
  en: {
    acknowledgement: "Acknowledgement Type",
    allowances: "Allowances",
    amountPaidNow: "Amount Paid Now",
    approvedBy: "Approved By",
    basicSalary: "Basic Salary",
    cashReceived: "Cash Received Acknowledgement",
    companyAuthorization: "Company Authorization",
    deductions: "Deductions",
    department: "Department",
    driverCommission: "Employee Driver Commission",
    earningAdjustments: "Earning Adjustments",
    earnings: "Earnings",
    employee: "Employee",
    employeeCount: "Employee Count",
    employeeNumber: "Employee Number",
    employeeSignature: "Employee Signature",
    employmentType: "Employment Type",
    externalReference: "External Reference",
    generatedAt: "Generated Date and Time",
    grossEarnings: "Gross Earnings",
    heldEmployees: "Held Employees",
    line: "#",
    netSalary: "Net Salary",
    notes: "Notes",
    outstanding: "Outstanding Amount",
    paid: "Paid",
    paidBy: "Paid By",
    paymentDate: "Payment Date",
    paymentNumber: "Payment Number",
    paymentReport: "Payroll Payment Report",
    paymentStatus: "Payment Status",
    payrollMonth: "Payroll Month",
    payrollPeriod: "Payroll Period",
    payrollRegister: "Employee Payroll Register",
    payslip: "Employee Payslip",
    payslipReference: "Payslip Reference",
    periodDates: "Period Start and End",
    preparedBy: "Prepared By",
    previouslyPaid: "Previously Paid",
    reason: "Reason",
    recipientAcknowledgement: "Employee / Recipient Acknowledgement",
    remainingOutstanding: "Remaining Outstanding",
    reversalReason: "Reversal Reason",
    reversedAt: "Reversed At",
    reversedBy: "Reversed By",
    status: "Status",
    totalAllowances: "Total Allowances",
    totalBasicSalary: "Total Basic Salary",
    totalDeductions: "Total Deductions",
    totalDriverCommission: "Total Driver Commission",
    totalEarningAdjustments: "Total Earning Adjustments",
    totalEmployees: "Total Employees",
    totalNetSalary: "Total Net Salary",
    totalOutstanding: "Total Outstanding",
    totalPaid: "Total Paid",
    totalPayment: "Total Payment",
    voucher: "Cash Voucher / Reference",
  },
} as const;

function escapeHtml(value: string | null | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(value: string): string {
  return `AED ${escapeHtml(value)}`;
}

const statusLabels: Readonly<Record<PayrollReportLanguage, Readonly<Record<string, string>>>> = {
  ar: {
    active: "نشط",
    approved: "معتمد",
    calculated: "محتسب",
    checkbox: "تم تأكيد إقرار الموظف",
    closed: "مغلق",
    confirmed: "مؤكد",
    draft: "مسودة",
    held: "موقوف",
    paid: "مدفوع",
    partially_paid: "مدفوع جزئياً",
    physical_signature: "توقيع ورقي",
    reversed: "معكوس",
    typed_name: "اسم الموظف المكتوب",
  },
  en: {},
};

function status(value: string, language: PayrollReportLanguage): string {
  return escapeHtml(statusLabels[language][value] ?? value.replaceAll("_", " "));
}

function companyHeader(
  company: PayrollReportCompany,
  title: string,
  language: PayrollReportLanguage,
): string {
  const subtitle =
    language === "ar"
      ? (company.subtitleAr ?? company.subtitleEn)
      : (company.subtitleEn ?? company.subtitleAr);
  return (
    `<header class="report-header"><div class="company-block">` +
    (company.logoDataUri === null
      ? ""
      : `<img class="company-logo" alt="" src="${escapeHtml(company.logoDataUri)}">`) +
    `<div><div class="company-name">${escapeHtml(company.nameEn)}` +
    (company.nameAr === null ? "" : ` / ${escapeHtml(company.nameAr)}`) +
    `</div>` +
    (subtitle === null ? "" : `<div class="muted">${escapeHtml(subtitle)}</div>`) +
    (company.telephone === null
      ? ""
      : `<div class="muted">${escapeHtml(company.telephone)}</div>`) +
    `</div></div><h1>${escapeHtml(title)}</h1></header>`
  );
}

function meta(items: readonly [string, string | null][]): string {
  return `<section class="meta-grid">${items
    .map(
      ([label, value]) =>
        `<div class="meta"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
    )
    .join("")}</section>`;
}

function summary(items: readonly [string, string][]): string {
  return `<section class="summary">${items
    .map(
      ([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`,
    )
    .join("")}</section>`;
}

function signatures(labelsToUse: readonly string[]): string {
  return `<section class="signatures">${labelsToUse
    .map(
      (label) =>
        `<div class="signature"><div class="signature-space"></div><span>${escapeHtml(label)}</span></div>`,
    )
    .join("")}</section>`;
}

function document(
  body: string,
  language: PayrollReportLanguage,
  title: string,
  landscape = false,
): string {
  const css = `
    @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 14mm 12mm 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172126; font: 10.5px "Segoe UI", Tahoma, Arial, sans-serif; }
    .report-header { padding-bottom: 8px; border-bottom: 2px solid #087e8b; }
    .company-block { display: flex; align-items: center; gap: 10px; }
    .company-logo { width: 52px; height: 52px; object-fit: contain; }
    .company-name { font-size: 16px; font-weight: 800; }
    .muted { color: #566b73; }
    h1 { margin: 9px 0 0; font-size: 18px; }
    h2 { margin: 14px 0 6px; color: #29434b; font-size: 13px; }
    .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; margin: 10px 0; }
    .meta { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-bottom: 1px dotted #c4d0d4; }
    .meta span { color: #566b73; }
    table { width: 100%; border-collapse: collapse; margin: 7px 0 10px; font-size: 9.5px; }
    thead { display: table-header-group; }
    th, td { padding: 4px 5px; border: 1px solid #aab9be; text-align: start; vertical-align: top; }
    th { background: #eaf3f4; font-weight: 750; }
    td.num, th.num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
    tr { break-inside: avoid; }
    .summary { width: min(440px, 100%); margin-inline-start: auto; }
    .summary > div { display: flex; justify-content: space-between; gap: 16px; padding: 4px 0; border-bottom: 1px solid #d8e1e4; }
    .notice { margin: 8px 0; padding: 7px 9px; border-inline-start: 3px solid #b33a3a; background: #fff0f0; }
    .signatures { display: flex; gap: 22px; margin-top: 38px; break-inside: avoid; }
    .signature { flex: 1; text-align: center; }
    .signature-space { height: 38px; border-bottom: 1px solid #445a62; margin-bottom: 5px; }
    [dir="rtl"] .num { direction: ltr; }
  `;
  return (
    `<!doctype html><html dir="${language === "ar" ? "rtl" : "ltr"}" lang="${language}">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head>` +
    `<body>${body}</body></html>`
  );
}

export function buildPayslipHtml(data: PayslipReportData, language: PayrollReportLanguage): string {
  const l = labels[language];
  const earningAdjustments = data.adjustments.filter((item) => item.direction === "earning");
  const deductions = data.adjustments.filter((item) => item.direction === "deduction");
  const earningsRows = [
    [l.basicSalary, data.header.basicSalary],
    ...data.allowances.map((item) => [
      language === "ar" ? (item.nameAr ?? item.nameEn) : item.nameEn,
      item.amount,
    ]),
    [l.driverCommission, data.header.driverCommission],
    ...earningAdjustments.map((item) => [`${item.type}: ${item.reason}`, item.amount]),
  ];
  const deductionRows = deductions.map((item) => [`${item.type}: ${item.reason}`, item.amount]);
  const table = (rows: readonly (readonly string[])[]) =>
    `<table><tbody>${rows
      .map(
        ([name, amount]) =>
          `<tr><td>${escapeHtml(name)}</td><td class="num">${money(amount ?? "0.00")}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  const reversal =
    data.header.reversalReason === null
      ? ""
      : `<div class="notice">${escapeHtml(l.reversalReason)}: ${escapeHtml(data.header.reversalReason)}</div>`;
  const body =
    companyHeader(data.company, l.payslip, language) +
    meta([
      [l.payrollPeriod, data.header.periodReference],
      [l.payrollMonth, data.header.payrollMonth],
      [l.payslipReference, data.header.payslipReference],
      [
        l.employee,
        language === "ar"
          ? (data.header.employeeNameAr ?? data.header.employeeName)
          : data.header.employeeName,
      ],
      [l.employeeNumber, data.header.employeeNumber],
      [l.employmentType, data.header.employmentType],
      [l.department, data.header.department],
      [l.status, status(data.header.status, language)],
      [l.generatedAt, data.generatedAt],
    ]) +
    reversal +
    `<h2>${escapeHtml(l.earnings)}</h2>${table(earningsRows)}` +
    summary([
      [l.grossEarnings, money(data.header.grossEarnings)],
      [l.totalDeductions, money(data.header.totalDeductions)],
      [l.netSalary, money(data.header.netSalary)],
    ]) +
    `<h2>${escapeHtml(l.deductions)}</h2>` +
    (deductionRows.length === 0 ? `<p class="muted">-</p>` : table(deductionRows)) +
    `<h2>${escapeHtml(l.paymentStatus)}</h2>` +
    meta([
      [l.previouslyPaid, money(data.payment.previouslyPaid)],
      [l.amountPaidNow, money(data.payment.amountPaidNow)],
      [l.outstanding, money(data.header.outstanding)],
      [l.paymentDate, data.payment.paymentDate],
      [l.voucher, data.payment.cashVoucherReference],
      [
        l.acknowledgement,
        data.payment.acknowledgementType === null
          ? null
          : (statusLabels[language][data.payment.acknowledgementType] ??
            data.payment.acknowledgementType.replaceAll("_", " ")),
      ],
      [l.paidBy, data.payment.paidBy],
      [l.notes, data.payment.notes],
      [l.preparedBy, data.header.preparedBy],
      [l.approvedBy, data.header.approvedBy],
    ]) +
    signatures([l.preparedBy, l.approvedBy, l.paidBy, l.employeeSignature, l.cashReceived]);
  return document(body, language, `${l.payslip} ${data.header.payslipReference}`);
}

export function buildPayrollRegisterHtml(
  data: PayrollRegisterReportData,
  language: PayrollReportLanguage,
): string {
  const l = labels[language];
  const rows = data.lines
    .map(
      (line, index) =>
        `<tr><td>${index + 1}</td><td>${escapeHtml(line.employeeNumber)}</td>` +
        `<td>${escapeHtml(line.employeeName)}</td><td>${escapeHtml(line.employmentType)}</td>` +
        [
          line.basicSalary,
          line.allowances,
          line.driverCommission,
          line.earningAdjustments,
          line.deductions,
          line.netSalary,
          line.paid,
          line.outstanding,
        ]
          .map((value) => `<td class="num">${money(value)}</td>`)
          .join("") +
        `<td>${status(line.status, language)}</td></tr>`,
    )
    .join("");
  const headings = [
    l.line,
    l.employeeNumber,
    l.employee,
    l.employmentType,
    l.basicSalary,
    l.allowances,
    l.driverCommission,
    l.earningAdjustments,
    l.deductions,
    l.netSalary,
    l.paid,
    l.outstanding,
    l.status,
  ];
  const body =
    companyHeader(data.company, l.payrollRegister, language) +
    meta([
      [l.payrollPeriod, data.header.periodReference],
      [l.periodDates, `${data.header.periodStart} - ${data.header.periodEnd}`],
      [l.status, status(data.header.status, language)],
      [l.preparedBy, data.header.preparedBy],
      [l.approvedBy, data.header.approvedBy],
      [l.generatedAt, data.generatedAt],
    ]) +
    `<table><thead><tr>${headings.map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    summary([
      [l.totalEmployees, String(data.summary.totalEmployees)],
      [l.heldEmployees, String(data.summary.heldEmployees)],
      [l.totalBasicSalary, money(data.summary.totalBasicSalary)],
      [l.totalAllowances, money(data.summary.totalAllowances)],
      [l.totalDriverCommission, money(data.summary.totalDriverCommission)],
      [l.totalEarningAdjustments, money(data.summary.totalEarningAdjustments)],
      [l.totalDeductions, money(data.summary.totalDeductions)],
      [l.totalNetSalary, money(data.summary.totalNetSalary)],
      [l.totalPaid, money(data.summary.totalPaid)],
      [l.totalOutstanding, money(data.summary.totalOutstanding)],
    ]);
  return document(body, language, `${l.payrollRegister} ${data.header.periodReference}`, true);
}

export function buildPayrollPaymentReportHtml(
  data: PayrollPaymentReportData,
  language: PayrollReportLanguage,
): string {
  const l = labels[language];
  const rows = data.allocations
    .map(
      (line, index) =>
        `<tr><td>${index + 1}</td><td>${escapeHtml(line.employeeNumber)}</td>` +
        `<td>${escapeHtml(line.employeeName)}</td><td class="num">${money(line.netSalary)}</td>` +
        `<td class="num">${money(line.previouslyPaid)}</td>` +
        `<td class="num">${money(line.amountPaidNow)}</td>` +
        `<td class="num">${money(line.remainingOutstanding)}</td>` +
        `<td>${status(line.lineStatus, language)}</td></tr>`,
    )
    .join("");
  const reversal =
    data.header.reversedAt === null
      ? ""
      : `<div class="notice">${escapeHtml(l.reversedAt)}: ${escapeHtml(data.header.reversedAt)}. ` +
        `${escapeHtml(l.reversedBy)}: ${escapeHtml(data.header.reversedBy)}. ` +
        `${escapeHtml(l.reversalReason)}: ${escapeHtml(data.header.reversalReason)}</div>`;
  const body =
    companyHeader(data.company, l.paymentReport, language) +
    meta([
      [l.paymentNumber, data.header.paymentNumber],
      [l.payrollPeriod, data.header.periodReference],
      [l.paymentDate, data.header.paymentDate],
      [l.totalPayment, money(data.header.totalAmount)],
      [l.voucher, data.header.cashVoucherReference],
      [l.externalReference, data.header.externalReference],
      [
        l.acknowledgement,
        statusLabels[language][data.header.acknowledgementType] ??
          data.header.acknowledgementType.replaceAll("_", " "),
      ],
      [l.status, status(data.header.status, language)],
      [l.paidBy, data.header.paidBy],
      [l.generatedAt, data.generatedAt],
    ]) +
    reversal +
    `<table><thead><tr>${[
      l.line,
      l.employeeNumber,
      l.employee,
      l.netSalary,
      l.previouslyPaid,
      l.amountPaidNow,
      l.remainingOutstanding,
      l.status,
    ]
      .map((item) => `<th>${escapeHtml(item)}</th>`)
      .join("")}</tr></thead><tbody>${rows}</tbody></table>` +
    summary([
      [l.employeeCount, String(data.summary.employeeCount)],
      [l.totalPayment, money(data.summary.totalPayment)],
      [l.totalOutstanding, money(data.summary.totalRemainingOutstanding)],
      [l.notes, escapeHtml(data.header.notes)],
    ]) +
    signatures([l.paidBy, l.companyAuthorization, l.recipientAcknowledgement]);
  return document(body, language, `${l.paymentReport} ${data.header.paymentNumber}`, true);
}

export function payrollFooter(language: PayrollReportLanguage): string {
  return language === "ar"
    ? `<div style="font-size:9px;width:100%;text-align:center;color:#666;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`
    : `<div style="font-size:9px;width:100%;text-align:center;color:#666;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
}
