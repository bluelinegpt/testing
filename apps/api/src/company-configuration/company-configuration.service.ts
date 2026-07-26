import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type {
  CreateBankAccountDto,
  UpdateCompanySettingsDto,
} from "./company-configuration.dto.js";

export interface CompanyArea {
  readonly code: string;
  readonly createdAt: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
}

export interface CompanyAreaSearchPage {
  readonly hasMore: boolean;
  readonly items: readonly CompanyArea[];
  readonly total: number;
}

export interface CompanySettings {
  readonly baseCurrency: string;
  readonly defaultLanguage: string;
  readonly documentExpiryAlertDays: number | null;
  readonly orderPendingAlertHours: number | null;
  readonly timezone: string;
  readonly vatEnabled: boolean;
  readonly vatPriceMode: string | null;
  readonly vatRate: string | null;
}

export interface CompanyBankAccount {
  readonly accountName: string;
  readonly accountNumberMasked: string | null;
  readonly bankName: string;
  readonly currency: string;
  readonly iban: string | null;
  readonly id: string;
  readonly isActive: boolean;
  readonly swiftCode: string | null;
}

@Injectable()
export class CompanyConfigurationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async settings(): Promise<CompanySettings> {
    const { companyId } = this.tenants.current();
    const result = await sql<CompanySettings>`
      insert into company_settings (company_id)
      values (${companyId}::uuid)
      on conflict (company_id) do update set company_id = excluded.company_id
      returning base_currency as "baseCurrency",
                default_language as "defaultLanguage",
                timezone,
                vat_enabled as "vatEnabled",
                vat_rate::text as "vatRate",
                vat_price_mode as "vatPriceMode",
                order_pending_alert_hours as "orderPendingAlertHours",
                document_expiry_alert_days as "documentExpiryAlertDays"
    `.execute(this.database);
    const settings = result.rows[0];
    if (settings === undefined) {
      throw new Error("Company settings query did not return a row");
    }
    return settings;
  }

  public async updateSettings(
    input: UpdateCompanySettingsDto,
    correlationId: string,
  ): Promise<CompanySettings> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    if (input.vatEnabled && (input.vatRate === undefined || input.vatPriceMode === undefined)) {
      throw new ApplicationException(
        "vat_settings_incomplete",
        "VAT rate and price mode are required when VAT is enabled",
        HttpStatus.BAD_REQUEST,
      );
    }
    const vatRate = input.vatEnabled ? input.vatRate : null;
    const vatPriceMode = input.vatEnabled ? input.vatPriceMode : null;
    return this.transactions.execute(async (transaction) => {
      const result = await sql<CompanySettings>`
        insert into company_settings (
          company_id, default_language, timezone, vat_enabled, vat_rate, vat_price_mode
        ) values (
          ${companyId}::uuid, ${input.defaultLanguage}, ${input.timezone.trim()},
          ${input.vatEnabled}, ${vatRate}, ${vatPriceMode}
        )
        on conflict (company_id)
        do update set default_language = excluded.default_language,
                      timezone = excluded.timezone,
                      vat_enabled = excluded.vat_enabled,
                      vat_rate = excluded.vat_rate,
                      vat_price_mode = excluded.vat_price_mode,
                      updated_at = now(),
                      version = company_settings.version + 1
        returning base_currency as "baseCurrency",
                  default_language as "defaultLanguage",
                  timezone,
                  vat_enabled as "vatEnabled",
                  vat_rate::text as "vatRate",
                  vat_price_mode as "vatPriceMode",
                  order_pending_alert_hours as "orderPendingAlertHours",
                  document_expiry_alert_days as "documentExpiryAlertDays"
      `.execute(transaction);
      const settings = result.rows[0];
      if (settings === undefined) {
        throw new Error("Company settings update did not return a row");
      }
      await this.audit(transaction, {
        action: "company_settings.update",
        actorId: identity.identityId,
        after: {
          defaultLanguage: input.defaultLanguage,
          timezone: input.timezone.trim(),
          vatEnabled: input.vatEnabled,
          vatPriceMode,
          vatRate,
        },
        companyId,
        correlationId,
        subjectId: companyId,
        subjectType: "company_settings",
      });
      return settings;
    });
  }

  // Area reads and writes live in AreaConfigurationService.

  public async bankAccounts(): Promise<readonly CompanyBankAccount[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<CompanyBankAccount>`
      select id,
             bank_name as "bankName",
             account_name as "accountName",
             account_number_masked as "accountNumberMasked",
             iban,
             swift_code as "swiftCode",
             currency,
             is_active as "isActive"
      from company_bank_accounts
      where company_id = ${companyId}::uuid
      order by is_active desc, lower(bank_name), lower(account_name)
    `.execute(this.database);
    return result.rows;
  }

  public async createBankAccount(
    input: CreateBankAccountDto,
    correlationId: string,
  ): Promise<CompanyBankAccount> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const bankName = input.bankName.trim();
    const accountName = input.accountName.trim();
    const accountNumberMasked = input.accountNumberMasked?.trim() || null;
    const iban = input.iban?.trim().toUpperCase() || null;
    const swiftCode = input.swiftCode?.trim().toUpperCase() || null;
    try {
      return await this.transactions.execute(async (transaction) => {
        const result = await sql<CompanyBankAccount>`
          insert into company_bank_accounts (
            company_id, bank_name, account_name, account_number_masked, iban, swift_code, currency, is_active
          ) values (
            ${companyId}::uuid, ${bankName}, ${accountName}, ${accountNumberMasked},
            ${iban}, ${swiftCode}, 'AED', true
          )
          returning id,
                    bank_name as "bankName",
                    account_name as "accountName",
                    account_number_masked as "accountNumberMasked",
                    iban,
                    swift_code as "swiftCode",
                    currency,
                    is_active as "isActive"
        `.execute(transaction);
        const account = result.rows[0];
        if (account === undefined) {
          throw new Error("Bank account creation did not return a row");
        }
        await this.audit(transaction, {
          action: "bank_account.create",
          actorId: identity.identityId,
          after: { accountName, bankName, iban, swiftCode },
          companyId,
          correlationId,
          subjectId: account.id,
          subjectType: "bank_account",
        });
        return account;
      });
    } catch (error) {
      this.rethrowDuplicate(
        error,
        "bank_account_exists",
        "A bank account with this IBAN already exists",
      );
      throw error;
    }
  }

  public async updateBankAccountStatus(
    bankAccountId: string,
    isActive: boolean,
    correlationId: string,
  ): Promise<CompanyBankAccount> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    return this.transactions.execute(async (transaction) => {
      const current = await sql<{ isActive: boolean }>`
        select is_active as "isActive"
        from company_bank_accounts
        where id = ${bankAccountId}::uuid and company_id = ${companyId}::uuid
        for update
      `.execute(transaction);
      const existing = current.rows[0];
      if (existing === undefined) {
        throw new ApplicationException(
          "bank_account_not_found",
          "Bank account not found",
          HttpStatus.NOT_FOUND,
        );
      }
      const result = await sql<CompanyBankAccount>`
        update company_bank_accounts
           set is_active = ${isActive},
               updated_at = now(),
               version = version + 1
         where id = ${bankAccountId}::uuid and company_id = ${companyId}::uuid
         returning id,
                   bank_name as "bankName",
                   account_name as "accountName",
                   account_number_masked as "accountNumberMasked",
                   iban,
                   swift_code as "swiftCode",
                   currency,
                   is_active as "isActive"
      `.execute(transaction);
      const account = result.rows[0];
      if (account === undefined) {
        throw new Error("Bank account status update did not return a row");
      }
      await this.audit(transaction, {
        action: "bank_account.status_update",
        actorId: identity.identityId,
        after: { from: existing.isActive, to: isActive },
        companyId,
        correlationId,
        subjectId: bankAccountId,
        subjectType: "bank_account",
      });
      return account;
    });
  }

  private rethrowDuplicate(error: unknown, code: string, message: string): void {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new ApplicationException(code, message, HttpStatus.CONFLICT);
    }
  }

  private async audit(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      action: string;
      actorId: string;
      after: object;
      companyId: string;
      correlationId: string;
      subjectId: string;
      subjectType: string;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action},
        ${input.subjectType}, ${input.subjectId}, ${JSON.stringify(input.after)}::jsonb,
        ${input.correlationId}
      )
    `.execute(database);
  }
}
