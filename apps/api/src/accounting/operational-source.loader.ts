import { HttpStatus, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AccountingFinancialComponent } from "./accounting.contracts.js";
import type { AccountingEventType, AccountingJournalSource } from "./accounting.constants.js";

export interface OperationalAccountingEventRecord {
  readonly actorId: string | null;
  readonly companyId: string;
  readonly correlationId: string;
  readonly effectiveAccountingDate: string;
  readonly eventHash: string;
  readonly eventType: AccountingEventType;
  readonly eventVersion: number;
  readonly id: string;
  readonly operationalArea: string;
  readonly reversalOfEventId: string | null;
  readonly sourceEntityId: string;
  readonly sourceEntityType: string;
  readonly sourceReference: string | null;
}

export interface OperationalJournalFacts {
  readonly accountingDate: string;
  readonly components: readonly AccountingFinancialComponent[];
  readonly description: string;
  readonly journalSource: AccountingJournalSource;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceReference: string;
}

function money(value: string | number | null | undefined): string {
  return new Decimal(value ?? 0).toDecimalPlaces(2).toFixed(2);
}

function component(
  componentType: AccountingFinancialComponent["componentType"],
  amount: string | number | null | undefined,
  entryIntent: "debit" | "credit",
  mappingKey: string,
  metadata: Readonly<Record<string, unknown>>,
  description: string,
): AccountingFinancialComponent | undefined {
  // greaterThan(0), not isPositive(): Decimal.isPositive() is a SIGN check
  // that returns true for zero, so a zero-value component (e.g. recoverable
  // input VAT on an out-of-scope Expense) was emitted instead of dropped and
  // then rejected by `accounting_event_components_amount_positive`.
  // A null/blank/NaN amount normalises to 0 and is dropped by the same test;
  // a negative amount is dropped too — a component only ever carries the
  // magnitude, with direction expressed by `entryIntent`.
  const normalized = new Decimal(
    amount === null || amount === undefined || amount === "" ? 0 : amount,
  ).toDecimalPlaces(2);
  if (!normalized.isFinite() || !normalized.greaterThan(0)) return undefined;
  return {
    amount: normalized.toFixed(2),
    componentType,
    description,
    entryIntent,
    mappingKey,
    metadata,
    sourceReference: String(metadata.sourceReference ?? ""),
    ...(typeof metadata.subledgerId === "string"
      ? {
          subledgerId: metadata.subledgerId,
          subledgerType: String(metadata.subledgerType ?? ""),
        }
      : {}),
  };
}

function present(
  values: readonly (AccountingFinancialComponent | undefined)[],
): AccountingFinancialComponent[] {
  return values.filter((value): value is AccountingFinancialComponent => value !== undefined);
}

@Injectable()
export class OperationalSourceLoader {
  public async load(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    switch (event.eventType) {
      case "order_delivered":
        return this.order(database, event);
      case "trader_receivable_recognized":
        return this.traderReceivable(database, event);
      case "trader_receivable_payment_received":
        return this.traderCollection(database, event);
      case "trader_settlement_confirmed":
        return this.traderSettlement(database, event);
      case "driver_collection_confirmed":
        return this.driverCollection(database, event);
      case "employee_payroll_approved":
        return this.payrollApproval(database, event);
      case "employee_payroll_paid":
        return this.payrollPayment(database, event);
      case "employee_variable_earnings_interim_paid":
        return this.employeeEarlyPayment(database, event, "variable");
      case "employee_salary_advance_paid":
        return this.employeeEarlyPayment(database, event, "salary_advance");
      case "outsourced_driver_fee_accrued":
        return this.driverFeeAccrual(database, event);
      case "outsourced_driver_fee_paid":
        return this.driverFeePayment(database, event);
      case "general_expense_approved":
        return this.generalExpense(database, event);
      case "general_expense_payment_completed":
        return this.generalExpensePayment(database, event);
      case "cash_deposit_confirmed":
      case "cash_withdrawal_confirmed":
      case "bank_deposit_confirmed":
      case "bank_withdrawal_confirmed":
      case "cash_to_bank_transfer_confirmed":
      case "bank_to_cash_transfer_confirmed":
      case "bank_to_bank_transfer_confirmed":
      case "cash_to_cash_transfer_confirmed":
        return this.cashBankMovement(database, event);
      default:
        throw new ApplicationException(
          "accounting_event_source_conflict",
          "This Accounting Event does not use a forward operational source loader",
          HttpStatus.CONFLICT,
        );
    }
  }

  private async cashBankMovement(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      accountingDate: string;
      amount: string;
      classificationMappingKey: string | null;
      destinationBankAccountId: string | null;
      destinationBankGlId: string | null;
      destinationCashAccountId: string | null;
      destinationCashGlId: string | null;
      description: string | null;
      feeAmount: string;
      movementNumber: string;
      movementType: string;
      sourceBankAccountId: string | null;
      sourceBankGlId: string | null;
      sourceCashAccountId: string | null;
      sourceCashGlId: string | null;
      status: string;
    }>`
      select m.movement_number as "movementNumber",m.movement_type as "movementType",
             m.accounting_date::text as "accountingDate",m.amount::text,
             m.fee_amount::text as "feeAmount",m.description,m.status,
             m.classification_mapping_key as "classificationMappingKey",
             m.source_cash_account_id as "sourceCashAccountId",
             sc.linked_gl_account_id as "sourceCashGlId",
             m.source_bank_account_id as "sourceBankAccountId",
             sb.linked_gl_account_id as "sourceBankGlId",
             m.destination_cash_account_id as "destinationCashAccountId",
             dc.linked_gl_account_id as "destinationCashGlId",
             m.destination_bank_account_id as "destinationBankAccountId",
             db.linked_gl_account_id as "destinationBankGlId"
        from cash_bank_movements m
        left join company_cash_accounts sc on sc.id=m.source_cash_account_id and sc.company_id=m.company_id
        left join company_bank_accounts sb on sb.id=m.source_bank_account_id and sb.company_id=m.company_id
        left join company_cash_accounts dc on dc.id=m.destination_cash_account_id and dc.company_id=m.company_id
        left join company_bank_accounts db on db.id=m.destination_bank_account_id and db.company_id=m.company_id
       where m.id=${event.sourceEntityId}::uuid and m.company_id=${event.companyId}::uuid
       for share of m
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined || row.status !== "confirmed") {
      this.invalidSource("accounting_cash_bank_movement_not_confirmed");
    }
    const base = {
      cashBankMovementId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "cash_bank_movement",
      sourceReference: row.movementNumber,
    };
    const sourceAccountId = row.sourceCashAccountId ?? row.sourceBankAccountId;
    const sourceGlId = row.sourceCashGlId ?? row.sourceBankGlId;
    const destinationAccountId = row.destinationCashAccountId ?? row.destinationBankAccountId;
    const destinationGlId = row.destinationCashGlId ?? row.destinationBankGlId;
    const sourceMetadata = {
      ...base,
      accountOverrideId: sourceGlId,
      ...(row.sourceCashAccountId === null
        ? { companyBankAccountId: sourceAccountId }
        : { companyCashAccountId: sourceAccountId }),
    };
    const destinationMetadata = {
      ...base,
      accountOverrideId: destinationGlId,
      ...(row.destinationCashAccountId === null
        ? { companyBankAccountId: destinationAccountId }
        : { companyCashAccountId: destinationAccountId }),
    };
    const transfer = row.movementType.includes("_to_");
    const deposit = row.movementType.endsWith("_deposit");
    const classificationKey =
      row.classificationMappingKey ??
      (deposit ? "cash_bank_deposit_source" : "cash_bank_withdrawal_destination");
    const components: (AccountingFinancialComponent | undefined)[] = transfer
      ? [
          component(
            "cash_bank_account",
            row.amount,
            "debit",
            "cash_bank_account",
            destinationMetadata,
            `${row.movementNumber} destination`,
          ),
          component(
            "cash_bank_account",
            row.amount,
            "credit",
            "cash_bank_account",
            sourceMetadata,
            `${row.movementNumber} source`,
          ),
        ]
      : deposit
        ? [
            component(
              "cash_bank_account",
              row.amount,
              "debit",
              "cash_bank_account",
              destinationMetadata,
              `${row.movementNumber} receipt`,
            ),
            component(
              "cash_bank_external_source",
              row.amount,
              "credit",
              classificationKey,
              base,
              `${row.movementNumber} source`,
            ),
          ]
        : [
            component(
              "cash_bank_external_destination",
              row.amount,
              "debit",
              classificationKey,
              base,
              `${row.movementNumber} destination`,
            ),
            component(
              "cash_bank_account",
              row.amount,
              "credit",
              "cash_bank_account",
              sourceMetadata,
              `${row.movementNumber} payment`,
            ),
          ];
    // greaterThan(0): only add a bank-charge component when a fee was really
    // taken. `component()` would now drop a zero anyway, but the intent is
    // clearer — and correct — stated here.
    if (new Decimal(row.feeAmount).greaterThan(0)) {
      components.push(
        component(
          "cash_bank_fee",
          row.feeAmount,
          "debit",
          "bank_charge",
          base,
          `${row.movementNumber} bank charge`,
        ),
        component(
          "cash_bank_account",
          row.feeAmount,
          "credit",
          "cash_bank_account",
          sourceMetadata,
          `${row.movementNumber} fee source`,
        ),
      );
    }
    return {
      accountingDate: row.accountingDate,
      components: present(components),
      description: row.description ?? `Cash/Bank movement ${row.movementNumber}`,
      journalSource: "cash_bank_management",
      metadata: base,
      sourceReference: row.movementNumber,
    };
  }

  private async order(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      additionalFees: string | null;
      companyRevenue: string;
      customerAmountDue: string;
      deliveredDate: string | null;
      deliveryStatus: string;
      driverId: string | null;
      financialModelVersion: string | null;
      orderNumber: string;
      serviceFeeNet: string | null;
      traderId: string;
      traderNetPayable: string;
      vatAmount: string;
    }>`
      select order_number as "orderNumber",trader_id as "traderId",
             assigned_driver_id as "driverId",delivery_status as "deliveryStatus",
             (delivered_at at time zone 'Asia/Dubai')::date::text as "deliveredDate",
             customer_amount_due::text as "customerAmountDue",
             trader_net_payable::text as "traderNetPayable",
             company_revenue::text as "companyRevenue",vat_amount::text as "vatAmount",
             service_fee_net_amount::text as "serviceFeeNet",
             additional_fees::text as "additionalFees",
             financial_model_version as "financialModelVersion"
        from orders where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined || row.deliveryStatus !== "delivered" || row.deliveredDate === null) {
      this.invalidSource("accounting_order_not_recognizable");
    }
    const dimensions = {
      driverId: row.driverId,
      orderId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "order",
      sourceReference: row.orderNumber,
      subledgerId: row.traderId,
      subledgerType: "trader",
      traderId: row.traderId,
    };
    const fullRevenue =
      row.financialModelVersion === null
        ? new Decimal(row.companyRevenue)
        : new Decimal(row.serviceFeeNet ?? 0).plus(row.additionalFees ?? 0);
    const fullVat = new Decimal(row.vatAmount);
    const fullFeeWithVat = fullRevenue.plus(fullVat);
    const traderPosition = new Decimal(row.traderNetPayable);
    const customerFundedFee = Decimal.max(
      new Decimal(row.customerAmountDue).minus(Decimal.max(traderPosition, 0)),
      0,
    );
    const recognitionRatio = fullFeeWithVat.greaterThan(0)
      ? Decimal.min(customerFundedFee.div(fullFeeWithVat), 1)
      : new Decimal(0);
    const revenue = money(fullRevenue.mul(recognitionRatio).toString());
    const vatAmount = money(fullVat.mul(recognitionRatio).toString());
    return {
      accountingDate: row.deliveredDate,
      components: present([
        component(
          "cod_receivable",
          row.customerAmountDue,
          "debit",
          "order_cod_receivable",
          dimensions,
          `Order ${row.orderNumber} receivable`,
        ),
        traderPosition.greaterThan(0)?component("trader_payable",traderPosition.toString(),"credit","trader_payable",dimensions,
          `Order ${row.orderNumber} Trader payable`):undefined,
        traderPosition.lessThan(0)?component("cod_receivable",traderPosition.abs().toString(),"debit","order_cod_receivable",dimensions,
          `Order ${row.orderNumber} Trader receivable`):undefined,
        component(
          "service_fee_revenue",
          revenue,
          "credit",
          "service_fee_revenue",
          dimensions,
          `Order ${row.orderNumber} Company revenue`,
        ),
        component(
          "output_vat",
          vatAmount,
          "credit",
          "output_vat",
          dimensions,
          `Order ${row.orderNumber} output VAT`,
        ),
      ]),
      description: `Order ${row.orderNumber} financial recognition`,
      journalSource: "order",
      metadata: { ...dimensions, financialModelVersion: row.financialModelVersion },
      sourceReference: row.orderNumber,
    };
  }

  private async traderReceivable(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      amount: string;
      businessDate: string;
      reason: string;
      receivableNumber: string;
      sourceType: string;
      status: string;
      traderId: string;
    }>`
      select receivable_number as "receivableNumber",trader_id as "traderId",
             source_type as "sourceType",business_date::text as "businessDate",
             original_amount_due::text as amount,status,reason
        from trader_receivables where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined || ["cancelled", "reversed"].includes(row.status)) {
      this.invalidSource("accounting_trader_receivable_not_recognizable");
    }
    const dimensions = {
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "trader_receivable",
      sourceReference: row.receivableNumber,
      subledgerId: event.sourceEntityId,
      subledgerType: "trader_receivable",
      traderId: row.traderId,
    };
    return {
      accountingDate: row.businessDate,
      components: present([
        component(
          "cod_receivable",
          row.amount,
          "debit",
          "order_cod_receivable",
          dimensions,
          `Trader receivable ${row.receivableNumber}`,
        ),
        component(
          "additional_fee_revenue",
          row.amount,
          "credit",
          "additional_fee_revenue",
          dimensions,
          row.reason,
        ),
      ]),
      description: `Trader receivable ${row.receivableNumber}`,
      journalSource: "trader_receivable",
      metadata: { ...dimensions, sourceType: row.sourceType },
      sourceReference: row.receivableNumber,
    };
  }

  private async traderCollection(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      amount: string;
      bankAccountId: string | null;
      collectionNumber: string;
      paymentDate: string;
      paymentMethod: string;
      status: string;
      traderId: string;
    }>`
      select collection_number as "collectionNumber",trader_id as "traderId",
             payment_date::text as "paymentDate",payment_method as "paymentMethod",
             amount_received::text as amount,company_bank_account_id as "bankAccountId",status
        from trader_collections where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined || row.status !== "confirmed") {
      this.invalidSource("accounting_trader_receivable_payment_not_confirmed");
    }
    const dimensions = {
      companyBankAccountId: row.bankAccountId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "trader_collection",
      sourceReference: row.collectionNumber,
      subledgerId: event.sourceEntityId,
      subledgerType: "trader_collection",
      traderId: row.traderId,
    };
    const cashMapping =
      row.paymentMethod === "cash" ? "trader_settlement_cash" : "trader_settlement_bank";
    return {
      accountingDate: row.paymentDate,
      components: present([
        component(
          "trader_settlement",
          row.amount,
          "debit",
          cashMapping,
          dimensions,
          `Trader collection ${row.collectionNumber}`,
        ),
        component(
          "cod_receivable",
          row.amount,
          "credit",
          "order_cod_receivable",
          dimensions,
          `Receivable settlement ${row.collectionNumber}`,
        ),
      ]),
      description: `Trader collection ${row.collectionNumber}`,
      journalSource: "trader_receivable",
      metadata: { ...dimensions, paymentMethod: row.paymentMethod },
      sourceReference: row.collectionNumber,
    };
  }

  private async traderSettlement(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const header = await sql<{
      businessDate: string;
      netPayable: string;
      settlementNumber: string;
      status: string;
      traderId: string;
    }>`
      select settlement_number as "settlementNumber",trader_id as "traderId",
             business_date::text as "businessDate",net_payable::text as "netPayable",status
        from trader_settlements where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = header.rows[0];
    if (row === undefined || row.status !== "confirmed") {
      this.invalidSource("accounting_trader_settlement_not_confirmed");
    }
    const payments = await sql<{
      amount: string;
      bankAccountId: string | null;
      id: string;
      paymentMethod: string;
    }>`
      select id,payment_method as "paymentMethod",amount::text,
             company_bank_account_id as "bankAccountId"
        from trader_settlement_payments
       where company_id=${event.companyId}::uuid
         and settlement_id=${event.sourceEntityId}::uuid
       order by created_at,id
    `.execute(database);
    const allocations = await sql<Record<string, unknown>>`
      select id,order_id as "orderId",gross_payable::text as "grossPayable",
             deductions_and_charges::text as "deductionsAndCharges",
             adjustments::text,net_payable::text as "netPayable"
        from trader_settlement_orders
       where company_id=${event.companyId}::uuid
         and settlement_id=${event.sourceEntityId}::uuid
       order by created_at,id
    `.execute(database);
    const base = {
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "trader_settlement",
      sourceReference: row.settlementNumber,
      subledgerId: row.traderId,
      subledgerType: "trader",
      traderId: row.traderId,
      traderSettlementId: event.sourceEntityId,
    };
    return {
      accountingDate: row.businessDate,
      components: present([
        component(
          "trader_payable",
          row.netPayable,
          "debit",
          "trader_payable",
          base,
          `Trader settlement ${row.settlementNumber}`,
        ),
        ...payments.rows.map((payment) =>
          component(
            "trader_settlement",
            payment.amount,
            "credit",
            payment.paymentMethod === "cash" ? "trader_settlement_cash" : "trader_settlement_bank",
            { ...base, companyBankAccountId: payment.bankAccountId, paymentRowId: payment.id },
            `${payment.paymentMethod} payment for ${row.settlementNumber}`,
          ),
        ),
      ]),
      description: `Trader settlement ${row.settlementNumber}`,
      journalSource: "trader_settlement",
      metadata: { ...base, allocations: allocations.rows, paymentRows: payments.rows },
      sourceReference: row.settlementNumber,
    };
  }

  private async driverCollection(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const header = await sql<{
      businessDate: string;
      driverId: string;
      feeDeduction: string;
      gross: string;
      number: string;
      status: string;
      totalExpenses: string;
    }>`
      select reconciliation_number as number,driver_id as "driverId",
             business_date::text as "businessDate",gross_collections::text as gross,
             driver_payable_deduction::text as "feeDeduction",
             reconciliation_expenses::text as "totalExpenses",status
        from driver_reconciliations where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = header.rows[0];
    if (row === undefined || row.status !== "confirmed") {
      this.invalidSource("accounting_driver_collection_not_confirmed");
    }
    const payments = await sql<{
      amount: string;
      bankAccountId: string | null;
      id: string;
      paymentMethod: string;
    }>`
      select id,payment_method as "paymentMethod",amount::text,
             company_bank_account_id as "bankAccountId"
        from driver_reconciliation_payments
       where company_id=${event.companyId}::uuid
         and reconciliation_id=${event.sourceEntityId}::uuid
       order by created_at,id
    `.execute(database);
    const allocations = await sql<Record<string, unknown>>`
      select id,order_id as "orderId",
             customer_collection_amount::text as "customerCollectionAmount",
             driver_payable_deduction::text as "driverPayableDeduction"
        from driver_reconciliation_orders
       where company_id=${event.companyId}::uuid
         and reconciliation_id=${event.sourceEntityId}::uuid
       order by created_at,id
    `.execute(database);
    const expenses = await sql<Record<string, unknown>>`
      select id,expense_type_id as "expenseTypeId",amount::text,description
        from driver_reconciliation_expenses
       where company_id=${event.companyId}::uuid
         and reconciliation_id=${event.sourceEntityId}::uuid
       order by created_at,id
    `.execute(database);
    const linkedFeePayment = await sql<{ id: string }>`
      select id from outsourced_driver_fee_payments
       where company_id=${event.companyId}::uuid
         and linked_driver_reconciliation_id=${event.sourceEntityId}::uuid
         and payment_source='driver_collection'
       order by created_at desc limit 1
    `.execute(database);
    const base = {
      driverCollectionId: event.sourceEntityId,
      driverId: row.driverId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "driver_reconciliation",
      sourceReference: row.number,
      subledgerId: row.driverId,
      subledgerType: "driver",
    };
    return {
      accountingDate: row.businessDate,
      components: present([
        ...payments.rows.map((payment) =>
          component(
            "driver_collection_cash",
            payment.amount,
            "debit",
            payment.paymentMethod === "cash" ? "driver_collection_cash" : "trader_settlement_bank",
            { ...base, companyBankAccountId: payment.bankAccountId, paymentRowId: payment.id },
            `${payment.paymentMethod} received in ${row.number}`,
          ),
        ),
        component(
          "driver_expense",
          row.totalExpenses,
          "debit",
          "driver_expense",
          base,
          `Driver expenses in ${row.number}`,
        ),
        component(
          "outsourced_driver_payable",
          row.feeDeduction,
          "debit",
          "driver_collection_fee_offset",
          base,
          `Driver fee offset in ${row.number}`,
        ),
        component(
          "cod_receivable",
          row.gross,
          "credit",
          "order_cod_receivable",
          base,
          `COD cleared by ${row.number}`,
        ),
      ]),
      description: `Driver collection ${row.number}`,
      journalSource: "driver_collection",
      metadata: {
        ...base,
        allocations: allocations.rows,
        expenses: expenses.rows,
        linkedFeePaymentId: linkedFeePayment.rows[0]?.id ?? null,
        paymentRows: payments.rows,
      },
      sourceReference: row.number,
    };
  }

  private async payrollApproval(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      periodEnd: string;
      periodReference: string;
      status: string;
      total: string;
    }>`
      select period_reference as "periodReference",period_end::text as "periodEnd",
             total_net_salary::text as total,status
        from payroll_periods where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (
      row === undefined ||
      !["approved", "partially_paid", "paid", "closed"].includes(row.status)
    ) {
      this.invalidSource("accounting_payroll_not_approved");
    }
    const payrollLines = await sql<{
      deliveredOrderEarningSources: readonly Record<string, unknown>[];
      deliveredOrderEarnings: string;
      employeeId: string;
      salaryAdvanceRecovery: string;
      variableAlreadyPaid: string;
      lineId: string;
      netSalary: string;
    }>`
      select l.id as "lineId",l.employee_id as "employeeId",
             l.net_salary::text as "netSalary",
             l.delivered_order_earnings::text as "deliveredOrderEarnings",
             l.salary_advance_recovery::text as "salaryAdvanceRecovery",
             l.variable_earnings_already_paid::text as "variableAlreadyPaid",
             -- Straight off the allocated snapshots. No join to orders and no
             -- join to the earning rules: the posted figure must be the one
             -- recorded at delivery time, so a later rate change or a returned
             -- Order cannot move a Journal that has already been posted.
             coalesce((select jsonb_agg(jsonb_build_object(
               'earningId', eoe.id,
               'orderId', eoe.order_id,
               'orderNumber', eoe.order_number,
               'deliveredAt', eoe.delivered_at,
               'appliedAmount', eoe.applied_amount::text,
               'ruleId', eoe.rule_id,
               'allocatedAt', eoe.allocated_at
             ) order by eoe.delivered_at, eoe.id)
               from employee_order_earnings eoe
              where eoe.company_id=l.company_id and eoe.payroll_entry_id=l.id),'[]'::jsonb)
               as "deliveredOrderEarningSources"
        from payroll_entries l
       where l.company_id=${event.companyId}::uuid
         and l.payroll_period_id=${event.sourceEntityId}::uuid
         and l.status not in ('held','reversed')
       order by l.employee_number_snapshot,l.id
    `.execute(database);
    const snapshottedTotal = payrollLines.rows.reduce(
      (sum, line) => sum.plus(line.netSalary),
      new Decimal(0),
    );
    if (!snapshottedTotal.equals(row.total)) {
      this.invalidSource("accounting_payroll_amount_mismatch");
    }
    const base = {
      payrollPeriodId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "payroll_period",
      sourceReference: row.periodReference,
      subledgerId: event.sourceEntityId,
      subledgerType: "payroll_period",
    };
    return {
      accountingDate: row.periodEnd,
      components: present(
        payrollLines.rows.flatMap((line) => {
          const dimensions = {
            ...base,
            employeeId: line.employeeId,
            payrollLineId: line.lineId,
            subledgerId: line.employeeId,
            subledgerType: "employee",
          };
          // The expense debit is SPLIT, not extended. Net Salary already
          // contains Delivered Order Earnings -- Prompt 3C folded the component
          // into gross and therefore into net -- so adding a further debit
          // would double the expense and unbalance the Journal against an
          // unchanged payable credit. Splitting makes the component separately
          // identifiable on its own Journal line while the finalized payroll
          // total, and every figure derived from it, stays exactly as approved.
          const net = new Decimal(line.netSalary);
          const variablePaid = new Decimal(line.variableAlreadyPaid);
          const salaryAdvance = new Decimal(line.salaryAdvanceRecovery);
          const recognized = net.plus(variablePaid).plus(salaryAdvance);
          // Capped at Net Salary. Deductions and advances can exceed the rest
          // of the line, and an uncapped split would emit a negative remainder
          // -- silently dropped by component() -- leaving a debit larger than
          // the credit and a Journal rejected as unbalanced. Both parts are
          // non-negative and sum to exactly Net Salary.
          const orderEarnings = Decimal.min(new Decimal(line.deliveredOrderEarnings), recognized);
          const remainingSalary = recognized.minus(orderEarnings);
          return [
            component(
              "payroll_expense",
              remainingSalary.toFixed(2),
              "debit",
              "employee_payroll_expense",
              dimensions,
              `Payroll expense ${row.periodReference}`,
            ),
            // Zero-valued components are dropped by component(), so a period
            // with no Order earnings posts exactly the two lines it always did.
            component(
              "payroll_expense",
              orderEarnings.toFixed(2),
              "debit",
              "employee_payroll_expense",
              {
                ...dimensions,
                deliveredOrderEarnings: {
                  count: line.deliveredOrderEarningSources.length,
                  sources: line.deliveredOrderEarningSources,
                  total: money(line.deliveredOrderEarnings),
                },
              },
              `Delivered Order Earnings ${row.periodReference}`,
            ),
            component(
              "employee_interim_payroll_clearing",
              line.variableAlreadyPaid,
              "credit",
              "employee_interim_payroll_clearing",
              dimensions,
              `Clear interim variable earnings ${row.periodReference}`,
            ),
            component(
              "employee_advances",
              line.salaryAdvanceRecovery,
              "credit",
              "employee_advances",
              dimensions,
              `Recover Salary Advance ${row.periodReference}`,
            ),
            component(
              "payroll_payable",
              line.netSalary,
              "credit",
              "employee_payroll_payable",
              dimensions,
              `Payroll payable ${row.periodReference}`,
            ),
          ];
        }),
      ),
      description: `Employee Payroll ${row.periodReference}`,
      journalSource: "employee_payroll",
      metadata: {
        ...base,
        // The per-line source arrays are deliberately omitted here: they are
        // already carried by the component that posts them, and repeating them
        // at Journal level would store the same audit trail twice.
        payrollLines: payrollLines.rows.map((line) => ({
          deliveredOrderEarnings: line.deliveredOrderEarnings,
          salaryAdvanceRecovery: line.salaryAdvanceRecovery,
          variableAlreadyPaid: line.variableAlreadyPaid,
          employeeId: line.employeeId,
          lineId: line.lineId,
          netSalary: line.netSalary,
        })),
        totalDeliveredOrderEarnings: payrollLines.rows
          .reduce((sum, line) => sum.plus(line.deliveredOrderEarnings), new Decimal(0))
          .toFixed(2),
        totalNetSalary: row.total,
      },
      sourceReference: row.periodReference,
    };
  }

  private async payrollPayment(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      amount: string;
      paymentDate: string;
      paymentMethod: string;
      paymentNumber: string;
      periodId: string;
      status: string;
    }>`
      select payment_number as "paymentNumber",payroll_period_id as "periodId",
             payment_date::text as "paymentDate",payment_method as "paymentMethod",
             total_amount::text as amount,status
        from payroll_payments where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined || row.status !== "confirmed" || row.paymentMethod !== "cash") {
      this.invalidSource("accounting_payroll_payment_method_invalid");
    }
    const allocations = await sql<{
      amount: string;
      employeeId: string;
      id: string;
      payrollLineId: string;
    }>`
      select id,employee_id as "employeeId",payroll_line_id as "payrollLineId",
             allocated_amount::text as amount
        from payroll_payment_allocations
       where company_id=${event.companyId}::uuid
         and payroll_payment_id=${event.sourceEntityId}::uuid and reversed_at is null
       order by allocation_order,id
    `.execute(database);
    const base = {
      payrollPaymentId: event.sourceEntityId,
      payrollPeriodId: row.periodId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "payroll_payment",
      sourceReference: row.paymentNumber,
      subledgerId: row.periodId,
      subledgerType: "payroll_period",
    };
    return {
      accountingDate: row.paymentDate,
      components: present([
        ...allocations.rows.map((allocation) =>
          component(
            "payroll_payable",
            allocation.amount,
            "debit",
            "employee_payroll_payable",
            {
              ...base,
              allocationId: allocation.id,
              employeeId: allocation.employeeId,
              payrollLineId: allocation.payrollLineId,
              subledgerId: allocation.employeeId,
              subledgerType: "employee",
            },
            `Payroll payment ${row.paymentNumber}`,
          ),
        ),
        component(
          "payroll_cash_payment",
          row.amount,
          "credit",
          "employee_payroll_cash_payment",
          base,
          `Cash paid ${row.paymentNumber}`,
        ),
      ]),
      description: `Employee Payroll payment ${row.paymentNumber}`,
      journalSource: "employee_payroll",
      metadata: { ...base, allocations: allocations.rows },
      sourceReference: row.paymentNumber,
    };
  }

  private async employeeEarlyPayment(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
    kind: "salary_advance" | "variable",
  ): Promise<OperationalJournalFacts> {
    const table = kind === "variable" ? "employee_variable_earning_payments" : "employee_salary_advances";
    const result = await sql<{
      amount: string;
      employeeId: string;
      fundingGlId: string | null;
      paymentDate: string;
      paymentMethod: string;
      reference: string;
      status: string;
    }>`
      select p.employee_id as "employeeId",p.payment_date::text as "paymentDate",
             p.payment_method as "paymentMethod",p.amount_paid::text as amount,
             ${sql.raw(kind === "variable" ? "p.payment_number" : "p.advance_number")} as reference,
             p.status,coalesce(c.linked_gl_account_id,b.linked_gl_account_id) as "fundingGlId"
        from ${sql.raw(table)} p
        left join company_cash_accounts c on c.id=p.company_cash_account_id and c.company_id=p.company_id
        left join company_bank_accounts b on b.id=p.company_bank_account_id and b.company_id=p.company_id
       where p.id=${event.sourceEntityId}::uuid and p.company_id=${event.companyId}::uuid
       for share of p
    `.execute(database);
    const row=result.rows[0];
    if(row===undefined||row.status!=="confirmed"||row.fundingGlId===null){
      this.invalidSource("accounting_employee_early_payment_invalid");
    }
    const mappingKey=kind==="variable"?"employee_interim_payroll_clearing":"employee_advances";
    const componentType: AccountingFinancialComponent["componentType"] =
      kind === "variable" ? "employee_interim_payroll_clearing" : "employee_advances";
    const base={employeeId:row.employeeId,sourceEntityId:event.sourceEntityId,
      sourceEntityType:kind==="variable"?"employee_variable_earning_payment":"employee_salary_advance",
      sourceReference:row.reference,subledgerId:row.employeeId,subledgerType:"employee"};
    return{accountingDate:row.paymentDate,components:present([
      component(componentType,row.amount,"debit",mappingKey,base,
        kind==="variable"?`Interim variable earnings ${row.reference}`:`Salary Advance ${row.reference}`),
      component("payroll_cash_payment",row.amount,"credit","employee_payroll_cash_payment",
        {...base,accountOverrideId:row.fundingGlId,employeeEarlyPaymentFunding:true},
        `${row.paymentMethod} paid ${row.reference}`),
    ]),description:kind==="variable"?`Employee variable earnings interim payment ${row.reference}`:
      `Employee Salary Advance ${row.reference}`,journalSource:"employee_payroll",metadata:base,
      sourceReference:row.reference};
  }

  private async driverFeeAccrual(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      businessDate: string;
      driverId: string;
      earned: string;
      orderId: string;
      sourceReference: string | null;
      status: string;
    }>`
      select driver_id as "driverId",order_id as "orderId",
             accrual_business_date::text as "businessDate",earned_amount::text as earned,
             source_reference as "sourceReference",status
        from outsourced_driver_fee_accruals where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined || ["reversed", "recovery_required"].includes(row.status)) {
      this.invalidSource("accounting_outsourced_driver_fee_not_eligible");
    }
    const reference = row.sourceReference ?? event.sourceEntityId;
    const base = {
      driverId: row.driverId,
      orderId: row.orderId,
      outsourcedDriverFeeAccrualId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "outsourced_driver_fee_accrual",
      sourceReference: reference,
      subledgerId: row.driverId,
      subledgerType: "driver",
    };
    return {
      accountingDate: row.businessDate,
      components: present([
        component(
          "outsourced_driver_fee_expense",
          row.earned,
          "debit",
          "outsourced_driver_fee_expense",
          base,
          `Outsourced Driver fee ${reference}`,
        ),
        component(
          "outsourced_driver_payable",
          row.earned,
          "credit",
          "outsourced_driver_payable",
          base,
          `Driver payable ${reference}`,
        ),
      ]),
      description: `Outsourced Driver fee accrual ${reference}`,
      journalSource: "outsourced_driver_fee",
      metadata: base,
      sourceReference: reference,
    };
  }

  private async driverFeePayment(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const result = await sql<{
      amount: string;
      driverId: string;
      paymentDate: string;
      paymentMethod: string;
      paymentNumber: string;
      paymentSource: string;
      status: string;
    }>`
      select payment_number as "paymentNumber",driver_id as "driverId",
             payment_date::text as "paymentDate",payment_method as "paymentMethod",
             payment_source as "paymentSource",amount_paid::text as amount,status
        from outsourced_driver_fee_payments where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid for share
    `.execute(database);
    const row = result.rows[0];
    if (
      row === undefined ||
      row.status !== "confirmed" ||
      row.paymentMethod !== "cash" ||
      row.paymentSource !== "separate_payment"
    ) {
      this.invalidSource("accounting_outsourced_driver_fee_payment_not_confirmed");
    }
    const allocations = await sql<{
      accrualId: string;
      amount: string;
      id: string;
    }>`
      select id,accrual_id as "accrualId",allocated_amount::text as amount
        from outsourced_driver_fee_payment_allocations
       where company_id=${event.companyId}::uuid
         and payment_id=${event.sourceEntityId}::uuid and reversed_at is null
       order by allocation_order,id
    `.execute(database);
    const base = {
      driverId: row.driverId,
      outsourcedDriverFeePaymentId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "outsourced_driver_fee_payment",
      sourceReference: row.paymentNumber,
      subledgerId: row.driverId,
      subledgerType: "driver",
    };
    return {
      accountingDate: row.paymentDate,
      components: present([
        ...allocations.rows.map((allocation) =>
          component(
            "outsourced_driver_payable",
            allocation.amount,
            "debit",
            "outsourced_driver_payable",
            {
              ...base,
              allocationId: allocation.id,
              outsourcedDriverFeeAccrualId: allocation.accrualId,
            },
            `Driver fee payment ${row.paymentNumber}`,
          ),
        ),
        component(
          "outsourced_driver_payment",
          row.amount,
          "credit",
          "outsourced_driver_cash_payment",
          base,
          `Cash payment ${row.paymentNumber}`,
        ),
      ]),
      description: `Outsourced Driver fee payment ${row.paymentNumber}`,
      journalSource: "outsourced_driver_fee",
      metadata: { ...base, allocations: allocations.rows },
      sourceReference: row.paymentNumber,
    };
  }

  private async generalExpense(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const header = await sql<{
      accountingDate: string;
      approvedAmount: string;
      expenseNumber: string;
      payeeId: string | null;
      payeeType: string | null;
      status: string;
    }>`
      select expense_number as "expenseNumber",
             accounting_date::text as "accountingDate",
             approved_amount::text as "approvedAmount",status,
             payee_type as "payeeType",payee_id as "payeeId"
        from general_expenses
       where id=${event.sourceEntityId}::uuid
         and company_id=${event.companyId}::uuid
       for share
    `.execute(database);
    const row = header.rows[0];
    if (
      row === undefined ||
      !["approved", "partially_paid", "paid", "reversed"].includes(row.status)
    ) {
      this.invalidSource("accounting_general_expense_not_approved");
    }
    const lines = await sql<{
      costAmount: string;
      description: string;
      driverId: string | null;
      employeeId: string | null;
      expenseMappingKey: string;
      id: string;
      orderId: string | null;
      recoverableVat: string;
      traderId: string | null;
      vatTreatment: string;
    }>`
      select id,description,expense_cost_amount::text as "costAmount",
             recoverable_vat_amount::text as "recoverableVat",
             expense_account_mapping_key as "expenseMappingKey",
             vat_treatment as "vatTreatment",trader_id as "traderId",
             driver_id as "driverId",employee_id as "employeeId",
             order_id as "orderId"
        from general_expense_lines
       where company_id=${event.companyId}::uuid
         and general_expense_id=${event.sourceEntityId}::uuid
       order by line_number,id
    `.execute(database);
    const base = {
      generalExpenseId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "general_expense",
      sourceReference: row.expenseNumber,
      subledgerId: event.sourceEntityId,
      subledgerType: "general_expense",
    };
    const components = present([
      ...lines.rows.flatMap((line) => {
        const dimensions = {
          ...base,
          driverId: line.driverId,
          employeeId: line.employeeId,
          expenseLineId: line.id,
          orderId: line.orderId,
          traderId: line.traderId,
        };
        return [
          component(
            "general_expense",
            line.costAmount,
            "debit",
            line.expenseMappingKey,
            dimensions,
            line.description,
          ),
          component(
            "input_vat",
            line.recoverableVat,
            "debit",
            "input_vat",
            dimensions,
            `Recoverable input VAT for ${row.expenseNumber}`,
          ),
        ];
      }),
      component(
        "general_expense_payable",
        row.approvedAmount,
        "credit",
        "general_expense_payable",
        {
          ...base,
          payeeId: row.payeeId,
          payeeType: row.payeeType,
        },
        `General Expense payable ${row.expenseNumber}`,
      ),
    ]);
    const debitTotal = components
      .filter((current) => current.entryIntent === "debit")
      .reduce((sum, current) => sum.plus(current.amount), new Decimal(0));
    if (!debitTotal.equals(row.approvedAmount)) {
      this.invalidSource("accounting_general_expense_amount_mismatch");
    }
    return {
      accountingDate: row.accountingDate,
      components,
      description: `General Expense ${row.expenseNumber}`,
      journalSource: "general_expense",
      metadata: { ...base, lineCount: lines.rows.length },
      sourceReference: row.expenseNumber,
    };
  }

  private async generalExpensePayment(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<OperationalJournalFacts> {
    const header = await sql<{
      accountingDate: string;
      amount: string;
      expenseId: string;
      expenseNumber: string;
      paymentNumber: string;
      status: string;
    }>`
      select p.payment_number as "paymentNumber",
             p.general_expense_id as "expenseId",
             e.expense_number as "expenseNumber",
             p.accounting_date::text as "accountingDate",
             p.amount::text,p.status
        from general_expense_payments p
        join general_expenses e
          on e.id=p.general_expense_id and e.company_id=p.company_id
       where p.id=${event.sourceEntityId}::uuid
         and p.company_id=${event.companyId}::uuid
       for share of p,e
    `.execute(database);
    const row = header.rows[0];
    if (row === undefined || !["confirmed", "reversed"].includes(row.status)) {
      this.invalidSource("accounting_general_expense_payment_not_confirmed");
    }
    // The two Cash identities are read as two distinctly named fields, because
    // one name for both is how they came to be confused: `cash_account_id` is
    // the GL account the payment credits, `company_cash_account_id` is the
    // drawer the money left. A Company that reuses a GL code on a replacement
    // Cash Account makes them one-to-many, so neither can stand in for the
    // other.
    const paymentRows = await sql<{
      amount: string;
      bankAccountId: string | null;
      cashGlAccountId: string | null;
      companyCashAccountId: string | null;
      id: string;
      paymentMethod: string;
    }>`
      select id,payment_method as "paymentMethod",amount::text,
             cash_account_id as "cashGlAccountId",
             company_cash_account_id as "companyCashAccountId",
             company_bank_account_id as "bankAccountId"
        from general_expense_payment_rows
       where company_id=${event.companyId}::uuid
         and general_expense_payment_id=${event.sourceEntityId}::uuid
       order by row_number,id
    `.execute(database);
    const rowTotal = paymentRows.rows.reduce(
      (sum, current) => sum.plus(current.amount),
      new Decimal(0),
    );
    if (!rowTotal.equals(row.amount)) {
      this.invalidSource("accounting_general_expense_payment_rows_mismatch");
    }
    const base = {
      generalExpenseId: row.expenseId,
      generalExpensePaymentId: event.sourceEntityId,
      sourceEntityId: event.sourceEntityId,
      sourceEntityType: "general_expense_payment",
      sourceReference: row.paymentNumber,
      subledgerId: row.expenseId,
      subledgerType: "general_expense",
    };
    return {
      accountingDate: row.accountingDate,
      components: present([
        component(
          "general_expense_payable",
          row.amount,
          "debit",
          "general_expense_payable",
          base,
          `Expense payable cleared by ${row.paymentNumber}`,
        ),
        ...paymentRows.rows.map((paymentRow) =>
          component(
            "general_expense_payment",
            paymentRow.amount,
            "credit",
            paymentRow.paymentMethod === "cash"
              ? "general_expense_cash_payment"
              : "general_expense_bank_payment",
            {
              ...base,
              // Accounting identity: the GL account this row credits.
              accountOverrideId:
                paymentRow.paymentMethod === "cash" ? paymentRow.cashGlAccountId : null,
              companyBankAccountId: paymentRow.bankAccountId,
              // Operational identity: null on rows written before the column
              // existed, and left null. Which drawer funded a historical
              // payment is not recoverable, and a value derived from the GL
              // account would be indistinguishable afterwards from a fact.
              companyCashAccountId: paymentRow.companyCashAccountId,
              paymentRowId: paymentRow.id,
            },
            `${paymentRow.paymentMethod} payment ${row.paymentNumber}`,
          ),
        ),
      ]),
      description: `General Expense payment ${row.paymentNumber}`,
      journalSource: "general_expense",
      metadata: {
        ...base,
        expenseNumber: row.expenseNumber,
        paymentRows: paymentRows.rows,
      },
      sourceReference: row.paymentNumber,
    };
  }

  private invalidSource(code: string): never {
    throw new ApplicationException(
      code,
      "The operational source does not permit this Accounting Event",
      HttpStatus.CONFLICT,
    );
  }
}

