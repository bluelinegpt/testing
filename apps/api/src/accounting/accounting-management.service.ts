import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  AccountingConfigurationDto,
  AccountMutationDto,
  AccountUpdateDto,
  CloseAccountMappingDto,
  CreateAccountMappingDto,
} from "./accounting.dto.js";
import { mapAccountingDatabaseError } from "./accounting-error.mapper.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";

function rethrowAccounting(error: unknown): never {
  if (error instanceof ApplicationException) throw error;
  return mapAccountingDatabaseError(error);
}

@Injectable()
export class AccountingManagementService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
  ) {}

  private async lockAccountConfigurationScope(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<void> {
    await sql`
      select pg_advisory_xact_lock(
        hashtextextended('accounting_account_configuration:' || ${companyId}::text, 0)
      )
    `.execute(database);
  }

  public async mappings() {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select m.id,m.mapping_key as "mappingKey",
             m.debit_account_id as "debitAccountId",da.code as "debitAccountCode",
             m.credit_account_id as "creditAccountId",ca.code as "creditAccountCode",
             m.vat_account_id as "vatAccountId",va.code as "vatAccountCode",
             m.fee_account_id as "feeAccountId",fa.code as "feeAccountCode",
             m.expense_account_id as "expenseAccountId",ea.code as "expenseAccountCode",
             m.payable_account_id as "payableAccountId",pa.code as "payableAccountCode",
             m.effective_from::text as "effectiveFrom",
             m.effective_to::text as "effectiveTo",m.is_active as "isActive",
             m.created_at as "createdAt",m.updated_at as "updatedAt"
        from account_mappings m
        left join chart_of_accounts da on da.id=m.debit_account_id and da.company_id=m.company_id
        left join chart_of_accounts ca on ca.id=m.credit_account_id and ca.company_id=m.company_id
        left join chart_of_accounts va on va.id=m.vat_account_id and va.company_id=m.company_id
        left join chart_of_accounts fa on fa.id=m.fee_account_id and fa.company_id=m.company_id
        left join chart_of_accounts ea on ea.id=m.expense_account_id and ea.company_id=m.company_id
        left join chart_of_accounts pa on pa.id=m.payable_account_id and pa.company_id=m.company_id
       where m.company_id=${companyId}::uuid
       order by m.mapping_key,m.effective_from desc,m.created_at desc
    `.execute(this.database);
    return result.rows;
  }

  public async createMapping(input: CreateAccountMappingDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.mapping.create",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        const inserted = await sql<Record<string, unknown>>`
          insert into account_mappings (
            company_id,mapping_key,debit_account_id,credit_account_id,vat_account_id,
            fee_account_id,expense_account_id,payable_account_id,effective_from,effective_to,
            created_by_account_id,updated_by_account_id
          ) values (
            ${companyId}::uuid,${input.mappingKey},${input.debitAccountId ?? null}::uuid,
            ${input.creditAccountId ?? null}::uuid,${input.vatAccountId ?? null}::uuid,
            ${input.feeAccountId ?? null}::uuid,${input.expenseAccountId ?? null}::uuid,
            ${input.payableAccountId ?? null}::uuid,${input.effectiveFrom}::date,
            ${input.effectiveTo ?? null}::date,${actorId}::uuid,${actorId}::uuid
          )
          returning id,mapping_key as "mappingKey",effective_from::text as "effectiveFrom",
                    effective_to::text as "effectiveTo",is_active as "isActive"
        `.execute(transaction);
        const response = inserted.rows[0]!;
        await this.support.audit(transaction, {
          action: "accounting.mapping.created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: String(response.id),
          subjectType: "account_mapping",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.mapping.create",
          resourceId: String(response.id),
          resourceType: "account_mapping",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async closeMapping(
    mappingId: string,
    input: CloseAccountMappingDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.mapping.close",
          payload: { mappingId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        const updated = await sql<Record<string, unknown>>`
          update account_mappings
             set effective_to=${input.effectiveTo}::date,updated_by_account_id=${actorId}::uuid,
                 updated_at=now()
           where id=${mappingId}::uuid and company_id=${companyId}::uuid and is_active
           returning id,mapping_key as "mappingKey",effective_from::text as "effectiveFrom",
                     effective_to::text as "effectiveTo",is_active as "isActive"
        `.execute(transaction);
        if (updated.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_mapping_not_found",
            "The active Accounting mapping was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        const response = updated.rows[0]!;
        await this.support.audit(transaction, {
          action: "accounting.mapping.closed",
          after: { ...response, reason: input.reason },
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: mappingId,
          subjectType: "account_mapping",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.mapping.close",
          resourceId: mappingId,
          resourceType: "account_mapping",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async createConfiguration(
    input: AccountingConfigurationDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    if (input.accountingEnabled === true) {
      throw new ApplicationException(
        "accounting_manual_enablement_required",
        "Use the readiness-controlled operation to enable Manual Accounting",
        HttpStatus.CONFLICT,
      );
    }
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.configuration.create",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        const inserted = await sql<Record<string, unknown>>`
          insert into accounting_configurations (
            company_id, accounting_enabled, automatic_posting_enabled,
            base_currency, fiscal_year_start_month, default_accounting_method,
            retained_earnings_account_id, current_year_earnings_account_id,
            default_rounding_account_id, default_suspense_account_id,
            default_cash_account_id, default_bank_account_id,
            default_vat_output_account_id, default_vat_input_account_id,
            default_accounts_receivable_account_id, default_accounts_payable_account_id,
            default_payroll_payable_account_id,
            default_outsourced_driver_payable_account_id,
            default_trader_payable_account_id,
            default_service_fee_revenue_account_id,
            default_delivery_revenue_account_id,
            created_by_account_id, updated_by_account_id
          ) values (
            ${companyId}::uuid, ${input.accountingEnabled ?? false}, false,
            ${input.baseCurrency ?? "AED"}, ${input.fiscalYearStartMonth ?? 1},
            ${input.defaultAccountingMethod ?? "accrual"},
            ${input.retainedEarningsAccountId ?? null}::uuid,
            ${input.currentYearEarningsAccountId ?? null}::uuid,
            ${input.defaultRoundingAccountId ?? null}::uuid,
            ${input.defaultSuspenseAccountId ?? null}::uuid,
            ${input.defaultCashAccountId ?? null}::uuid,
            ${input.defaultBankAccountId ?? null}::uuid,
            ${input.defaultVatOutputAccountId ?? null}::uuid,
            ${input.defaultVatInputAccountId ?? null}::uuid,
            ${input.defaultAccountsReceivableAccountId ?? null}::uuid,
            ${input.defaultAccountsPayableAccountId ?? null}::uuid,
            ${input.defaultPayrollPayableAccountId ?? null}::uuid,
            ${input.defaultOutsourcedDriverPayableAccountId ?? null}::uuid,
            ${input.defaultTraderPayableAccountId ?? null}::uuid,
            ${input.defaultServiceFeeRevenueAccountId ?? null}::uuid,
            ${input.defaultDeliveryRevenueAccountId ?? null}::uuid,
            ${actorId}::uuid, ${actorId}::uuid
          )
          returning company_id as "companyId", accounting_enabled as "accountingEnabled",
                    automatic_posting_enabled as "automaticPostingEnabled",
                    base_currency as "baseCurrency",
                    fiscal_year_start_month as "fiscalYearStartMonth",
                    default_accounting_method as "defaultAccountingMethod",
                    version::text as version
        `.execute(transaction);
        const response = inserted.rows[0] ?? {};
        await this.support.audit(transaction, {
          action: "accounting.configuration.created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: companyId,
          subjectType: "accounting_configuration",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.configuration.create",
          resourceId: companyId,
          resourceType: "accounting_configuration",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async updateConfiguration(
    input: AccountingConfigurationDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    if (input.accountingEnabled === true) {
      throw new ApplicationException(
        "accounting_manual_enablement_required",
        "Use the readiness-controlled operation to enable Manual Accounting",
        HttpStatus.CONFLICT,
      );
    }
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.configuration.update",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        const payload = JSON.stringify(input);
        const result = await sql<Record<string, unknown>>`
          update accounting_configurations c
             set accounting_enabled = case when ${payload}::jsonb ? 'accountingEnabled'
                   then (${payload}::jsonb->>'accountingEnabled')::boolean
                   else c.accounting_enabled end,
                 base_currency = coalesce(${payload}::jsonb->>'baseCurrency', c.base_currency),
                 fiscal_year_start_month = case when ${payload}::jsonb ? 'fiscalYearStartMonth'
                   then (${payload}::jsonb->>'fiscalYearStartMonth')::integer
                   else c.fiscal_year_start_month end,
                 default_accounting_method =
                   coalesce(${payload}::jsonb->>'defaultAccountingMethod', c.default_accounting_method),
                 retained_earnings_account_id = case when ${payload}::jsonb ? 'retainedEarningsAccountId'
                   then (${payload}::jsonb->>'retainedEarningsAccountId')::uuid
                   else c.retained_earnings_account_id end,
                 current_year_earnings_account_id = case when ${payload}::jsonb ? 'currentYearEarningsAccountId'
                   then (${payload}::jsonb->>'currentYearEarningsAccountId')::uuid
                   else c.current_year_earnings_account_id end,
                 default_rounding_account_id = case when ${payload}::jsonb ? 'defaultRoundingAccountId'
                   then (${payload}::jsonb->>'defaultRoundingAccountId')::uuid
                   else c.default_rounding_account_id end,
                 default_suspense_account_id = case when ${payload}::jsonb ? 'defaultSuspenseAccountId'
                   then (${payload}::jsonb->>'defaultSuspenseAccountId')::uuid
                   else c.default_suspense_account_id end,
                 default_cash_account_id = case when ${payload}::jsonb ? 'defaultCashAccountId'
                   then (${payload}::jsonb->>'defaultCashAccountId')::uuid
                   else c.default_cash_account_id end,
                 default_bank_account_id = case when ${payload}::jsonb ? 'defaultBankAccountId'
                   then (${payload}::jsonb->>'defaultBankAccountId')::uuid
                   else c.default_bank_account_id end,
                 default_vat_output_account_id = case when ${payload}::jsonb ? 'defaultVatOutputAccountId'
                   then (${payload}::jsonb->>'defaultVatOutputAccountId')::uuid
                   else c.default_vat_output_account_id end,
                 default_vat_input_account_id = case when ${payload}::jsonb ? 'defaultVatInputAccountId'
                   then (${payload}::jsonb->>'defaultVatInputAccountId')::uuid
                   else c.default_vat_input_account_id end,
                 default_accounts_receivable_account_id = case when ${payload}::jsonb ? 'defaultAccountsReceivableAccountId'
                   then (${payload}::jsonb->>'defaultAccountsReceivableAccountId')::uuid
                   else c.default_accounts_receivable_account_id end,
                 default_accounts_payable_account_id = case when ${payload}::jsonb ? 'defaultAccountsPayableAccountId'
                   then (${payload}::jsonb->>'defaultAccountsPayableAccountId')::uuid
                   else c.default_accounts_payable_account_id end,
                 default_payroll_payable_account_id = case when ${payload}::jsonb ? 'defaultPayrollPayableAccountId'
                   then (${payload}::jsonb->>'defaultPayrollPayableAccountId')::uuid
                   else c.default_payroll_payable_account_id end,
                 default_outsourced_driver_payable_account_id = case when ${payload}::jsonb ? 'defaultOutsourcedDriverPayableAccountId'
                   then (${payload}::jsonb->>'defaultOutsourcedDriverPayableAccountId')::uuid
                   else c.default_outsourced_driver_payable_account_id end,
                 default_trader_payable_account_id = case when ${payload}::jsonb ? 'defaultTraderPayableAccountId'
                   then (${payload}::jsonb->>'defaultTraderPayableAccountId')::uuid
                   else c.default_trader_payable_account_id end,
                 default_service_fee_revenue_account_id = case when ${payload}::jsonb ? 'defaultServiceFeeRevenueAccountId'
                   then (${payload}::jsonb->>'defaultServiceFeeRevenueAccountId')::uuid
                   else c.default_service_fee_revenue_account_id end,
                 default_delivery_revenue_account_id = case when ${payload}::jsonb ? 'defaultDeliveryRevenueAccountId'
                   then (${payload}::jsonb->>'defaultDeliveryRevenueAccountId')::uuid
                   else c.default_delivery_revenue_account_id end,
                 updated_by_account_id = ${actorId}::uuid, updated_at = now(),
                 version = c.version + 1
           where c.company_id = ${companyId}::uuid
           returning c.company_id as "companyId", c.accounting_enabled as "accountingEnabled",
                     c.automatic_posting_enabled as "automaticPostingEnabled",
                     c.base_currency as "baseCurrency",
                     c.fiscal_year_start_month as "fiscalYearStartMonth",
                     c.default_accounting_method as "defaultAccountingMethod",
                     c.version::text as version
        `.execute(transaction);
        const response = result.rows[0];
        if (response === undefined) {
          throw new ApplicationException(
            "accounting_configuration_not_found",
            "Accounting configuration has not been created",
            HttpStatus.NOT_FOUND,
          );
        }
        await this.support.audit(transaction, {
          action: "accounting.configuration.updated",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: companyId,
          subjectType: "accounting_configuration",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.configuration.update",
          resourceId: companyId,
          resourceType: "accounting_configuration",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async readiness(database?: Kysely<DatabaseSchema>) {
    const { companyId } = this.support.context();
    const work = async (db: Kysely<DatabaseSchema>) => {
      const result = await sql<{
        activePostingAccounts: number;
        configurationExists: boolean;
        currencyValid: boolean;
        invalidSystemAssignments: number;
        openPeriods: number;
        validFiscalYears: number;
      }>`
        select
          exists(select 1 from accounting_configurations where company_id=${companyId}::uuid)
            as "configurationExists",
          exists(select 1 from accounting_configurations
                  where company_id=${companyId}::uuid and base_currency='AED')
            as "currencyValid",
          (select count(*)::int from fiscal_years
            where company_id=${companyId}::uuid and status in ('open','reopened'))
            as "validFiscalYears",
          (select count(*)::int from accounting_periods
            where company_id=${companyId}::uuid and status in ('open','reopened'))
            as "openPeriods",
          (select count(*)::int from chart_of_accounts
            where company_id=${companyId}::uuid and is_active and is_posting_account)
            as "activePostingAccounts",
          (select count(*)::int
             from chart_of_accounts a
            where a.company_id=${companyId}::uuid and a.is_system_account
              and (not a.is_active or not a.is_posting_account))
            as "invalidSystemAssignments"
      `.execute(db);
      const state = result.rows[0]!;
      const missingRequirements: string[] = [];
      if (!state.configurationExists) missingRequirements.push("accounting_configuration");
      if (!state.currencyValid) missingRequirements.push("aed_configuration");
      if (state.validFiscalYears < 1) missingRequirements.push("open_fiscal_year");
      if (state.openPeriods < 1) missingRequirements.push("open_fiscal_period");
      if (state.activePostingAccounts < 2) missingRequirements.push("two_posting_accounts");
      if (state.invalidSystemAssignments > 0) missingRequirements.push("valid_system_accounts");
      return {
        ...state,
        automaticPostingEnabled: false,
        missingRequirements,
        ready: missingRequirements.length === 0,
        status: missingRequirements.length === 0 ? "ready" : "not_ready",
        warnings: ["Automatic operational posting remains disabled"],
      };
    };
    if (database !== undefined) return work(database);
    return this.transactions.execute(work);
  }

  public async enableManualAccounting(idempotencyKey: string | undefined) {
    this.support.assertPermission("accounting.configuration.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.configuration.enable_manual",
          payload: { enable: true },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        await this.lockAccountConfigurationScope(
          transaction,
          this.support.context().companyId,
        );
        const readiness = await this.readiness(transaction);
        if (!readiness.ready) {
          throw new ApplicationException(
            "accounting_not_ready",
            "Manual Accounting cannot be enabled until the required foundations are ready",
            HttpStatus.CONFLICT,
            readiness.missingRequirements,
          );
        }
        const { actorId, companyId } = this.support.context();
        const result = await sql<Record<string, unknown>>`
          update accounting_configurations
             set accounting_enabled=true, automatic_posting_enabled=false,
                 manual_accounting_activation_date=current_date,
                 manual_accounting_enabled_by_account_id=${actorId}::uuid,
                 manual_accounting_enabled_at=now(),
                 updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
           where company_id=${companyId}::uuid
           returning company_id as "companyId", accounting_enabled as "accountingEnabled",
                     automatic_posting_enabled as "automaticPostingEnabled",
                     version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: "accounting.configuration.manual_enabled",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: companyId,
          subjectType: "accounting_configuration",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.configuration.enable_manual",
          resourceId: companyId,
          resourceType: "accounting_configuration",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async createAccount(input: AccountMutationDto, idempotencyKey: string | undefined) {
    this.support.assertPermission("accounting.chart_of_accounts.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.account.create",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        const id = randomUUID();
        const result = await sql<Record<string, unknown>>`
          insert into chart_of_accounts (
            id, company_id, parent_account_id, code, name_en, name_ar,
            account_type, account_class, is_posting_account, is_active,
            normal_balance, is_contra_account, is_control_account, control_account_type,
            is_system_account, system_purpose, currency, description,
            effective_from, effective_to, created_by_account_id, updated_by_account_id
          ) values (
            ${id}::uuid, ${companyId}::uuid, ${input.parentAccountId ?? null}::uuid,
            ${input.code.trim()}, ${input.nameEn.trim()}, ${input.nameAr?.trim() ?? null},
            ${input.accountType}, ${input.accountClass}, ${input.isPostingAccount}, true,
            ${input.normalBalance}, ${input.isContraAccount ?? false},
            ${input.isControlAccount ?? false}, ${input.controlAccountType ?? null},
            ${input.isSystemAccount ?? false}, ${input.systemPurpose ?? null},
            'AED', ${input.description?.trim() ?? null},
            ${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date,
            ${actorId}::uuid, ${actorId}::uuid
          )
          returning id, code, name_en as "nameEn", name_ar as "nameAr",
                    account_type as "accountType", account_class as "accountClass",
                    is_posting_account as "isPostingAccount",
                    is_active as "isActive", version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: "accounting.account.created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: id,
          subjectType: "chart_of_account",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.account.create",
          resourceId: id,
          resourceType: "chart_of_account",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async updateAccount(
    accountId: string,
    input: AccountUpdateDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.chart_of_accounts.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.account.update",
          payload: { accountId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        await sql`select id from chart_of_accounts where id=${accountId}::uuid
                    and company_id=${companyId}::uuid for update`.execute(transaction);
        const payload = JSON.stringify(input);
        const result = await sql<Record<string, unknown>>`
          update chart_of_accounts a
             set name_en = coalesce(${payload}::jsonb->>'nameEn', a.name_en),
                 name_ar = case when ${payload}::jsonb ? 'nameAr'
                   then ${payload}::jsonb->>'nameAr' else a.name_ar end,
                 description = case when ${payload}::jsonb ? 'description'
                   then ${payload}::jsonb->>'description' else a.description end,
                 parent_account_id = case when ${payload}::jsonb ? 'parentAccountId'
                   then (${payload}::jsonb->>'parentAccountId')::uuid else a.parent_account_id end,
                 account_class = coalesce(${payload}::jsonb->>'accountClass', a.account_class),
                 normal_balance = coalesce(${payload}::jsonb->>'normalBalance', a.normal_balance),
                 is_posting_account = case when ${payload}::jsonb ? 'isPostingAccount'
                   then (${payload}::jsonb->>'isPostingAccount')::boolean else a.is_posting_account end,
                 is_control_account = case when ${payload}::jsonb ? 'isControlAccount'
                   then (${payload}::jsonb->>'isControlAccount')::boolean else a.is_control_account end,
                 control_account_type = case when ${payload}::jsonb ? 'controlAccountType'
                   then ${payload}::jsonb->>'controlAccountType' else a.control_account_type end,
                 is_system_account = case when ${payload}::jsonb ? 'isSystemAccount'
                   then (${payload}::jsonb->>'isSystemAccount')::boolean else a.is_system_account end,
                 system_purpose = case when ${payload}::jsonb ? 'systemPurpose'
                   then ${payload}::jsonb->>'systemPurpose' else a.system_purpose end,
                 is_contra_account = case when ${payload}::jsonb ? 'isContraAccount'
                   then (${payload}::jsonb->>'isContraAccount')::boolean else a.is_contra_account end,
                 effective_from = case when ${payload}::jsonb ? 'effectiveFrom'
                   then (${payload}::jsonb->>'effectiveFrom')::date else a.effective_from end,
                 effective_to = case when ${payload}::jsonb ? 'effectiveTo'
                   then (${payload}::jsonb->>'effectiveTo')::date else a.effective_to end,
                 updated_by_account_id=${actorId}::uuid, updated_at=now(), version=a.version+1
           where a.id=${accountId}::uuid and a.company_id=${companyId}::uuid
           returning id, code, name_en as "nameEn", name_ar as "nameAr",
                     account_type as "accountType", account_class as "accountClass",
                     parent_account_id as "parentAccountId",
                     is_posting_account as "isPostingAccount",
                     is_active as "isActive", version::text as version
        `.execute(transaction);
        const response = result.rows[0];
        if (response === undefined) {
          throw new ApplicationException(
            "accounting_account_not_found",
            "The Accounting Account was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        await this.support.audit(transaction, {
          action: "accounting.account.updated",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: accountId,
          subjectType: "chart_of_account",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.account.update",
          resourceId: accountId,
          resourceType: "chart_of_account",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async accountDependencies(accountId: string, database?: Kysely<DatabaseSchema>) {
    const { companyId } = this.support.context();
    const work = async (db: Kysely<DatabaseSchema>) => {
      const result = await sql<Record<string, number | boolean>>`
        select
          exists(select 1 from chart_of_accounts where id=${accountId}::uuid
                   and company_id=${companyId}::uuid) as "accountExists",
          (select count(*)::int from chart_of_accounts where parent_account_id=${accountId}::uuid
             and company_id=${companyId}::uuid and is_active) as "activeChildren",
          (select count(*)::int from journal_lines l join journal_entries j
             on j.id=l.journal_entry_id and j.company_id=l.company_id
            where l.account_id=${accountId}::uuid and l.company_id=${companyId}::uuid
              and j.status in ('posted','reversed')) as "postedJournalLines",
          (select count(*)::int from account_mappings m
            where m.company_id=${companyId}::uuid and m.is_active
              and ${accountId}::uuid in (
                m.debit_account_id,m.credit_account_id,m.vat_account_id,
                m.fee_account_id,m.expense_account_id,m.payable_account_id
              )) as "activeMappings",
          (select count(*)::int from accounting_configurations c
            where c.company_id=${companyId}::uuid and ${accountId}::uuid in (
              c.retained_earnings_account_id,c.current_year_earnings_account_id,
              c.default_rounding_account_id,c.default_suspense_account_id,
              c.default_cash_account_id,c.default_bank_account_id,
              c.default_vat_output_account_id,c.default_vat_input_account_id,
              c.default_accounts_receivable_account_id,c.default_accounts_payable_account_id,
              c.default_payroll_payable_account_id,c.default_outsourced_driver_payable_account_id,
              c.default_trader_payable_account_id,c.default_service_fee_revenue_account_id,
              c.default_delivery_revenue_account_id
            )) as "configurationAssignments"
      `.execute(db);
      const state = result.rows[0]!;
      if (!state.accountExists) {
        throw new ApplicationException(
          "accounting_account_not_found",
          "The Accounting Account was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      const blocking = Number(state.activeChildren) + Number(state.activeMappings)
        + Number(state.configurationAssignments);
      return { ...state, canDeactivate: blocking === 0, blockingDependencies: blocking };
    };
    if (database !== undefined) return work(database);
    return this.transactions.execute(work);
  }

  public async setAccountActive(
    accountId: string,
    active: boolean,
    reason: string,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.chart_of_accounts.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = active ? "accounting.account.activate" : "accounting.account.deactivate";
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { accountId, active, reason },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockAccountConfigurationScope(transaction, companyId);
        await sql`select id from chart_of_accounts where id=${accountId}::uuid
                    and company_id=${companyId}::uuid for update`.execute(transaction);
        if (!active) {
          const dependencies = await this.accountDependencies(accountId, transaction);
          if (!dependencies.canDeactivate) {
            throw new ApplicationException(
              "accounting_account_deactivation_blocked",
              "The Account has active dependencies and requires a replacement",
              HttpStatus.CONFLICT,
            );
          }
        }
        const result = await sql<Record<string, unknown>>`
          update chart_of_accounts
             set is_active=${active}, updated_by_account_id=${actorId}::uuid,
                 updated_at=now(), version=version+1,
                 deactivated_by_account_id=case when ${active} then null else ${actorId}::uuid end,
                 deactivated_at=case when ${active} then null else now() end
           where id=${accountId}::uuid and company_id=${companyId}::uuid
           returning id, code, is_active as "isActive", version::text as version
        `.execute(transaction);
        const response =
          result.rows[0] === undefined ? undefined : { ...result.rows[0], reason: reason.trim() };
        if (response === undefined) {
          throw new ApplicationException(
            "accounting_account_not_found",
            "The Accounting Account was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        await this.support.audit(transaction, {
          action: active ? "accounting.account.activated" : "accounting.account.deactivated",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: accountId,
          subjectType: "chart_of_account",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: accountId,
          resourceType: "chart_of_account",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async accountHierarchy() {
    const { companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const result = await sql<Record<string, unknown>>`
        with recursive hierarchy as (
          select a.*, 0 as depth, array[a.code]::text[] as path
            from chart_of_accounts a
           where a.company_id=${companyId}::uuid and a.parent_account_id is null
          union all
          select child.*, parent.depth + 1, parent.path || child.code
            from chart_of_accounts child
            join hierarchy parent on parent.id=child.parent_account_id
           where child.company_id=${companyId}::uuid
        )
        select id, parent_account_id as "parentAccountId", code,
               name_en as "nameEn", name_ar as "nameAr",
               account_type as "accountType", account_class as "accountClass",
               is_posting_account as "isPostingAccount", is_active as "isActive",
               depth, path
          from hierarchy order by path
      `.execute(transaction);
      return result.rows;
    });
  }
}
