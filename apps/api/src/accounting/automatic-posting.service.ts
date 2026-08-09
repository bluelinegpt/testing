import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AutomaticPostingChangeDto } from "./accounting-integration.dto.js";
import {
  accountingOperationalAreas,
  type AccountingOperationalArea,
} from "./accounting-ownership.matrix.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import {
  accountingMandatoryMappings,
  accountingSetupMappingsByArea,
} from "./accounting-setup.constants.js";

@Injectable()
export class AutomaticPostingService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
  ) {}

  public async status() {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select accounting_enabled as "accountingEnabled",
             automatic_posting_enabled as "automaticPostingEnabled",
             automatic_posting_areas as "enabledAreas",
             automatic_posting_enabled_at as "enabledAt",
             automatic_posting_disabled_at as "disabledAt",
             automatic_posting_change_reason as "changeReason",version::text as version
        from accounting_configurations where company_id=${companyId}::uuid
    `.execute(this.database);
    return (
      result.rows[0] ?? {
        accountingEnabled: false,
        automaticPostingEnabled: false,
        enabledAreas: [],
      }
    );
  }

  public async readiness(
    requestedAreas: readonly string[] = accountingOperationalAreas,
    activationDate = new Date().toISOString().slice(0, 10),
    database: Kysely<DatabaseSchema> = this.database,
  ) {
    this.support.assertAnyPermission("accounting.view", "accounting.configuration.manage");
    const { companyId } = this.support.context();
    const configuration = await sql<{
      accountingEnabled: boolean;
      baseCurrency: string;
    }>`
      select accounting_enabled as "accountingEnabled",base_currency as "baseCurrency"
        from accounting_configurations where company_id=${companyId}::uuid
    `.execute(database);
    const config = configuration.rows[0];
    const conditionalUsage = await sql<{
      additionalFeesUsed: boolean;
      bankChargeUsed: boolean;
      generalExpenseVatUsed: boolean;
      usedClassificationKeys: string[] | null;
      vatEnabled: boolean;
    }>`
      select
        exists(select 1 from company_settings
          where company_id=${companyId}::uuid and vat_enabled) as "vatEnabled",
        exists(select 1 from orders
          where company_id=${companyId}::uuid and additional_fees>0) as "additionalFeesUsed",
        exists(select 1 from general_expenses
          where company_id=${companyId}::uuid and vat_amount>0) as "generalExpenseVatUsed",
        exists(select 1 from cash_bank_movements
          where company_id=${companyId}::uuid and fee_amount>0) as "bankChargeUsed",
        (select array_agg(distinct classification_mapping_key)
           from cash_bank_movements
          where company_id=${companyId}::uuid
            and classification_mapping_key is not null) as "usedClassificationKeys"
    `.execute(database);
    const usage = conditionalUsage.rows[0] ?? {
      additionalFeesUsed: false,
      bankChargeUsed: false,
      generalExpenseVatUsed: false,
      usedClassificationKeys: [],
      vatEnabled: false,
    };
    const conditionApplies = (key: string) => {
      if (key === "additional_fee_revenue") return usage.additionalFeesUsed;
      if (key === "output_vat") return usage.vatEnabled;
      if (key === "input_vat") return usage.vatEnabled || usage.generalExpenseVatUsed;
      if (key === "bank_charge") return usage.bankChargeUsed;
      return (usage.usedClassificationKeys ?? []).includes(key);
    };
    const period = await sql<{ available: boolean }>`
      select exists(
        select 1 from accounting_periods p
        join fiscal_years y on y.id=p.fiscal_year_id and y.company_id=p.company_id
         where p.company_id=${companyId}::uuid
           and ${activationDate}::date between p.period_start and p.period_end
           and p.status in ('open','reopened') and y.status in ('open','reopened')
      ) as available
    `.execute(database);
    const areas = [];
    for (const area of [...new Set(requestedAreas)] as AccountingOperationalArea[]) {
      if (!accountingOperationalAreas.includes(area)) continue;
      const areaDefinitions = [...new Set(accountingSetupMappingsByArea[area])]
        .map((key) => accountingMandatoryMappings.find((item) => item.key === key))
        .filter((item) => item !== undefined);
      const required = areaDefinitions
        .filter((item) => item.requirement === "mandatory" || conditionApplies(item.key))
        .map((item) => item.key);
      const notCurrentlyApplicable = areaDefinitions
        .filter((item) => item.requirement === "conditional" && !conditionApplies(item.key))
        .map((item) => item.key);
      const mappings = await sql<{
        creditAccountId: string | null;
        debitAccountId: string | null;
        expenseAccountId: string | null;
        feeAccountId: string | null;
        key: string;
        payableAccountId: string | null;
        vatAccountId: string | null;
      }>`
        select m.mapping_key as key,
               m.debit_account_id as "debitAccountId",
               m.credit_account_id as "creditAccountId",
               m.vat_account_id as "vatAccountId",
               m.fee_account_id as "feeAccountId",
               m.expense_account_id as "expenseAccountId",
               m.payable_account_id as "payableAccountId"
          from account_mappings m
         where m.company_id=${companyId}::uuid and m.is_active
           and m.mapping_key=any(${required}::text[])
           and m.effective_from<=${activationDate}::date
           and coalesce(m.effective_to,'infinity'::date)>=${activationDate}::date
      `.execute(database);
      const mappingAccounts = await Promise.all(
        required.map(async (key) => {
          const definition = accountingMandatoryMappings.find((item) => item.key === key);
          const matchingMappings = mappings.rows.filter((row) => row.key === key);
          const mapping = matchingMappings[0];
          const accountId =
            definition === undefined || mapping === undefined ? null : mapping[definition.field];
          if (definition === undefined || accountId === null || matchingMappings.length !== 1) {
            return {
              accountId,
              compatible: false,
              duplicate: matchingMappings.length > 1,
              key,
            };
          }
          const account = await sql<{
            accountClass: string;
            accountType: string;
            active: boolean;
            control: boolean;
            controlType: string | null;
            normalBalance: string;
            posting: boolean;
          }>`
          select account_type as "accountType",account_class as "accountClass",
                 is_active as active,is_posting_account as posting,
                 is_control_account as control,control_account_type as "controlType",
                 normal_balance as "normalBalance"
            from chart_of_accounts
           where company_id=${companyId}::uuid and id=${accountId}::uuid
        `.execute(database);
          const selected = account.rows[0];
          return {
            accountId,
            compatible:
              selected !== undefined &&
              selected.active &&
              selected.posting &&
              selected.accountType === definition.accountType &&
              definition.accountClasses.includes(selected.accountClass) &&
              selected.normalBalance ===
                (["asset", "expense"].includes(definition.accountType) ? "debit" : "credit") &&
              (definition.controlType === undefined ||
                (selected.control && selected.controlType === definition.controlType)),
            duplicate: false,
            key,
          };
        }),
      );
      const configured = new Set(
        mappingAccounts.filter((row) => row.accountId !== null).map((row) => row.key),
      );
      const missingMappings = required.filter((key) => !configured.has(key));
      const invalidMappings = mappingAccounts
        .filter((row) => (row.accountId !== null || row.duplicate) && !row.compatible)
        .map((row) => ({ accountId: row.accountId, mappingKey: row.key }));
      const financialAccountReadiness =
        area === "cash_bank_management"
          ? await sql<{ invalid: string; total: string }>`
            select count(*)::text as total,
                   count(*) filter(where a.id is null or not a.is_active
                     or not a.is_posting_account or a.account_type<>'asset'
                     or a.account_class not in('cash','bank'))::text as invalid
              from (
                select company_id,linked_gl_account_id from company_cash_accounts
                 where company_id=${companyId}::uuid and is_active
                union all
                select company_id,linked_gl_account_id from company_bank_accounts
                 where company_id=${companyId}::uuid and is_active
              ) f
              left join chart_of_accounts a
                on a.id=f.linked_gl_account_id and a.company_id=f.company_id
          `.execute(database)
          : undefined;
      const blockers = [
        ...(config?.accountingEnabled ? [] : ["manual_accounting_disabled"]),
        ...(config?.baseCurrency === "AED" ? [] : ["base_currency_not_aed"]),
        ...(period.rows[0]?.available ? [] : ["open_fiscal_period_missing"]),
        ...(missingMappings.length === 0 ? [] : ["required_mapping_missing"]),
        ...(invalidMappings.length === 0 ? [] : ["required_mapping_invalid"]),
        ...(financialAccountReadiness === undefined ||
        financialAccountReadiness.rows[0]?.total !== "0"
          ? []
          : ["cash_bank_account_master_missing"]),
        ...(financialAccountReadiness === undefined ||
        financialAccountReadiness.rows[0]?.invalid === "0"
          ? []
          : ["cash_bank_linked_gl_invalid"]),
      ];
      areas.push({
        activationBlockers: blockers,
        area,
        invalidMappings,
        missingMappings,
        notCurrentlyApplicable,
        ready: blockers.length === 0,
        requiredMappings: required,
        status: blockers.length === 0 ? "ready" : "not_ready",
        warnings:
          area === "driver_expenses"
            ? ["Driver Collection-owned expenses are posted within the Driver Collection Event"]
            : [],
      });
    }
    return {
      activationDate,
      areas,
      ready: areas.length > 0 && areas.every((area) => area.ready),
    };
  }

  public async enable(input: AutomaticPostingChangeDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    const readiness = await this.readiness(input.areas);
    if (!readiness.ready) {
      throw new ApplicationException(
        "accounting_automatic_posting_not_ready",
        "Automatic posting cannot be enabled until every selected area is ready",
        HttpStatus.CONFLICT,
      );
    }
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.automatic-posting.enable",
        payload: input,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      const result = await sql<Record<string, unknown>>`
        update accounting_configurations
           set automatic_posting_enabled=true,
               automatic_posting_areas=${[...new Set(input.areas)]}::text[],
               automatic_posting_enabled_by_account_id=${actorId}::uuid,
               automatic_posting_enabled_at=now(),
               automatic_posting_disabled_by_account_id=null,
               automatic_posting_disabled_at=null,
               automatic_posting_change_reason=${input.reason.trim()},
               updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
         where company_id=${companyId}::uuid
         returning automatic_posting_enabled as "automaticPostingEnabled",
                   automatic_posting_areas as "enabledAreas",
                   automatic_posting_enabled_at as "enabledAt",version::text as version
      `.execute(transaction);
      const response = result.rows[0]!;
      await this.support.audit(transaction, {
        action: "accounting.automatic_posting.enabled",
        after: response,
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: companyId,
        subjectType: "accounting_configuration",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.automatic-posting.enable",
        resourceId: companyId,
        resourceType: "accounting_configuration",
        responseBody: response,
      });
      return response;
    });
  }

  public async disable(reason: string, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.automatic-posting.disable",
        payload: { reason: reason.trim() },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      const result = await sql<Record<string, unknown>>`
        update accounting_configurations
           set automatic_posting_enabled=false,
               automatic_posting_disabled_by_account_id=${actorId}::uuid,
               automatic_posting_disabled_at=now(),
               automatic_posting_change_reason=${reason.trim()},
               updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
         where company_id=${companyId}::uuid
         returning automatic_posting_enabled as "automaticPostingEnabled",
                   automatic_posting_areas as "enabledAreas",
                   automatic_posting_disabled_at as "disabledAt",version::text as version
      `.execute(transaction);
      const response = result.rows[0]!;
      await this.support.audit(transaction, {
        action: "accounting.automatic_posting.disabled",
        after: response,
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: companyId,
        subjectType: "accounting_configuration",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.automatic-posting.disable",
        resourceId: companyId,
        resourceType: "accounting_configuration",
        responseBody: response,
      });
      return response;
    });
  }

  public async setArea(area: string, enabled: boolean, reason: string, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    if (!accountingOperationalAreas.includes(area as AccountingOperationalArea)) {
      throw new ApplicationException(
        "accounting_automatic_posting_area_invalid",
        "The selected Accounting posting area is invalid",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (enabled) {
      const readiness = await this.readiness([area]);
      if (!readiness.ready) {
        throw new ApplicationException(
          "accounting_automatic_posting_not_ready",
          "This Automatic Posting area is not ready",
          HttpStatus.CONFLICT,
        );
      }
    }
    return this.transactions.execute(async (transaction) => {
      const operation = `accounting.automatic-posting.area.${enabled ? "enable" : "disable"}`;
      const payload = { area, enabled, reason: reason.trim() };
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation,
        payload,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      await sql`select 1 from accounting_configurations
        where company_id=${companyId}::uuid for update`.execute(transaction);
      await sql`select pg_advisory_xact_lock(hashtextextended(
        'accounting_account_configuration:'||${companyId}::text,0))`.execute(transaction);
      if (enabled) {
        const currentReadiness = await this.readiness([area], undefined, transaction);
        if (!currentReadiness.ready) {
          throw new ApplicationException(
            "accounting_automatic_posting_not_ready",
            "This Automatic Posting area is no longer ready",
            HttpStatus.CONFLICT,
          );
        }
      }
      const result = await sql<Record<string, unknown>>`
        update accounting_configurations
           set automatic_posting_areas=case when ${enabled}
                 then case when ${area}=any(automatic_posting_areas)
                   then automatic_posting_areas
                   else array_append(automatic_posting_areas,${area}) end
                 else array_remove(automatic_posting_areas,${area}) end,
               automatic_posting_enabled=case when ${enabled} then true
                 else cardinality(array_remove(automatic_posting_areas,${area}))>0 end,
               automatic_posting_enabled_by_account_id=case when ${enabled}
                 then ${actorId}::uuid else automatic_posting_enabled_by_account_id end,
               automatic_posting_enabled_at=case when ${enabled}
                 then coalesce(automatic_posting_enabled_at,now())
                 else automatic_posting_enabled_at end,
               automatic_posting_disabled_by_account_id=case
                 when not ${enabled}
                   and cardinality(array_remove(automatic_posting_areas,${area}))=0
                 then ${actorId}::uuid else automatic_posting_disabled_by_account_id end,
               automatic_posting_disabled_at=case
                 when not ${enabled}
                   and cardinality(array_remove(automatic_posting_areas,${area}))=0
                 then now() else automatic_posting_disabled_at end,
               automatic_posting_change_reason=${reason.trim()},
               updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
         where company_id=${companyId}::uuid and accounting_enabled
         returning automatic_posting_enabled as "automaticPostingEnabled",
                   automatic_posting_areas as "enabledAreas",version::text as version
      `.execute(transaction);
      if (result.rows[0] === undefined) {
        throw new ApplicationException(
          "accounting_manual_accounting_disabled",
          "Manual Accounting must be enabled before changing Automatic Posting areas",
          HttpStatus.CONFLICT,
        );
      }
      const response = { ...result.rows[0], changedArea: area, enabled };
      await this.support.audit(transaction, {
        action: `accounting.automatic_posting.area_${enabled ? "enabled" : "disabled"}`,
        after: { ...response, reason: reason.trim() },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: companyId,
        subjectType: "accounting_configuration",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation,
        resourceId: companyId,
        resourceType: "accounting_configuration",
        responseBody: response,
      });
      return response;
    });
  }
}
