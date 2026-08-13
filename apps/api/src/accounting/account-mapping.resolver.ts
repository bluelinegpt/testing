import { HttpStatus, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AccountingFinancialComponent } from "./accounting.contracts.js";

export interface ResolvedOperationalLine {
  readonly accountCode: string;
  readonly accountId: string;
  readonly accountNameAr: string | null;
  readonly accountNameEn: string;
  readonly amount: string;
  readonly component: AccountingFinancialComponent;
}

@Injectable()
export class AccountMappingResolver {
  public async resolve(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    accountingDate: string,
    components: readonly AccountingFinancialComponent[],
  ): Promise<readonly ResolvedOperationalLine[]> {
    const resolved: ResolvedOperationalLine[] = [];
    for (const current of components) {
      const financialAccountOverride = current.metadata?.accountOverrideId;
      if (
        current.mappingKey === "cash_bank_account" &&
        typeof financialAccountOverride === "string"
      ) {
        const override = await sql<{
          accountCode: string;
          accountId: string;
          accountNameAr: string | null;
          accountNameEn: string;
          active: boolean;
          posting: boolean;
          control: boolean;
          controlType: string | null;
        }>`
          select id as "accountId",code as "accountCode",
                 name_en as "accountNameEn",name_ar as "accountNameAr",
                 is_active as active,is_posting_account as posting,
                 is_control_account as control,control_account_type as "controlType"
            from chart_of_accounts
           where id=${financialAccountOverride}::uuid and company_id=${companyId}::uuid
             and account_type='asset' and account_class in('cash','bank')
           for share
        `.execute(database);
        const account = override.rows[0];
        if (account === undefined || !account.active || !account.posting) {
          throw new ApplicationException(
            "accounting_cash_bank_gl_account_invalid",
            "The linked Cash/Bank General Ledger Account cannot receive postings",
            HttpStatus.CONFLICT,
          );
        }
        resolved.push({ ...account, amount: current.amount, component: current });
        continue;
      }
      const result = await sql<{
        accountCode: string;
        accountId: string;
        accountNameAr: string | null;
        accountNameEn: string;
        active: boolean;
        posting: boolean;
        control: boolean;
        controlType: string | null;
      }>`
        select a.id as "accountId",a.code as "accountCode",
               a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
               a.is_active as active,a.is_posting_account as posting,
               a.is_control_account as control,a.control_account_type as "controlType"
          from account_mappings m
          join chart_of_accounts a
            on a.company_id=m.company_id
           and a.id=case
             when ${current.entryIntent}='debit'
               then coalesce(m.debit_account_id,m.expense_account_id,m.vat_account_id,
                             m.fee_account_id,m.payable_account_id,m.credit_account_id)
             else coalesce(m.credit_account_id,m.payable_account_id,m.vat_account_id,
                           m.fee_account_id,m.expense_account_id,m.debit_account_id)
           end
         where m.company_id=${companyId}::uuid
           and m.mapping_key=${current.mappingKey} and m.is_active
           and m.effective_from<=${accountingDate}::date
           and coalesce(m.effective_to,'infinity'::date)>=${accountingDate}::date
         order by m.effective_from desc
         for share of m,a
      `.execute(database);
      if (result.rows.length === 0) {
        throw new ApplicationException(
          "accounting_event_mapping_missing",
          `No effective Accounting mapping exists for ${current.mappingKey}`,
          HttpStatus.CONFLICT,
        );
      }
      if (result.rows.length !== 1) {
        throw new ApplicationException(
          "accounting_event_mapping_overlap",
          `More than one effective Accounting mapping exists for ${current.mappingKey}`,
          HttpStatus.CONFLICT,
        );
      }
      let account = result.rows[0]!;
      const overrideId = current.metadata?.accountOverrideId;
      if (current.mappingKey === "general_expense_cash_payment" && typeof overrideId === "string") {
        const override = await sql<typeof account>`
          select id as "accountId",code as "accountCode",
                 name_en as "accountNameEn",name_ar as "accountNameAr",
                 is_active as active,is_posting_account as posting,
                 is_control_account as control,control_account_type as "controlType"
            from chart_of_accounts
           where id=${overrideId}::uuid and company_id=${companyId}::uuid
             and account_type='asset' and account_class='cash'
           for share
        `.execute(database);
        if (override.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_general_expense_cash_account_invalid",
            "The selected Cash Account cannot receive this Expense payment",
            HttpStatus.CONFLICT,
          );
        }
        account = override.rows[0];
      }
      if (current.metadata?.employeeEarlyPaymentFunding === true && typeof overrideId === "string") {
        const override = await sql<typeof account>`
          select id as "accountId",code as "accountCode",name_en as "accountNameEn",
                 name_ar as "accountNameAr",is_active as active,is_posting_account as posting,
                 is_control_account as control,control_account_type as "controlType"
            from chart_of_accounts
           where id=${overrideId}::uuid and company_id=${companyId}::uuid
             and account_type='asset' and account_class in('cash','bank')
           for share
        `.execute(database);
        if (override.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_employee_payment_funding_invalid",
            "The selected Employee payment account cannot receive postings",
            HttpStatus.CONFLICT,
          );
        }
        account = override.rows[0];
      }
      if (!account.active || !account.posting) {
        throw new ApplicationException(
          account.active
            ? "accounting_event_mapping_summary_account"
            : "accounting_event_mapping_inactive_account",
          `The mapped Account for ${current.mappingKey} cannot receive postings`,
          HttpStatus.CONFLICT,
        );
      }
      const requiredControlType: Readonly<Record<string, string>> = {
        driver_collection_fee_offset: "driver_payable",
        employee_payroll_payable: "payroll_payable",
        employee_advances: "employee_advances",
        employee_interim_payroll_clearing: "employee_interim_payroll_clearing",
        general_expense_payable: "accounts_payable",
        order_cod_receivable: "accounts_receivable",
        outsourced_driver_payable: "driver_payable",
        trader_payable: "trader_payable",
      };
      const expectedControl = requiredControlType[current.mappingKey];
      if (
        expectedControl !== undefined &&
        (!account.control || account.controlType !== expectedControl)
      ) {
        throw new ApplicationException(
          "accounting_event_mapping_control_account_invalid",
          `The mapping ${current.mappingKey} requires a ${expectedControl} Control Account`,
          HttpStatus.CONFLICT,
        );
      }
      resolved.push({ ...account, amount: current.amount, component: current });
    }
    return resolved;
  }
}
