import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type {
  ChangeTraderBankStatusDto,
  ChangeTraderStatusDto,
  CreateConfiguredTraderDto,
  CreateTraderPricingDto,
  SaveTraderBankAccountDto,
  UpdateTraderPricingDto,
  UpdateConfiguredTraderDto,
} from "./trader-configuration.dto.js";

type Transaction = Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0];

export interface TraderPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface TraderSummary {
  readonly code: string;
  readonly contactPerson: string | null;
  readonly currentServiceFee: string | null;
  readonly id: string;
  readonly mobileNumber: string;
  readonly mobileWarning: boolean;
  readonly name: string;
  readonly outstandingAmount: string;
  readonly pickupArea: string | null;
  readonly pricingType: "configured" | null;
  readonly status: "active" | "disabled";
}

@Injectable()
export class TraderConfigurationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
  ) {}

  public async traders(query: Record<string, string>): Promise<TraderPage<TraderSummary>> {
    const { companyId } = this.tenants.current();
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 1), 100);
    const offset = (page - 1) * pageSize;
    const search = query.search?.trim().toLowerCase() ?? "";
    const status = query.status === "active" || query.status === "disabled" ? query.status : null;
    const pricingType =
      query.pricingType === "configured" || query.pricingType === "not_configured"
        ? query.pricingType
        : null;
    const areaId = query.areaId?.trim() || null;
    const sortColumns: Record<string, string> = {
      code: "t.code",
      mobile: "t.mobile_number",
      name: "t.name_en",
      status: "t.account_status",
    };
    const sort = sortColumns[query.sortBy ?? "name"] ?? sortColumns.name!;
    const direction = query.sortDirection === "desc" ? "desc" : "asc";
    const result = await sql<TraderSummary & { total: number }>`
      with price_summary as (
        select company_id, trader_id,
               count(*)::int as rule_count,
               max(service_fee) filter (where emirate_id is null and area_id is null) as base_fee
          from trader_service_prices
         group by company_id, trader_id
      ), outstanding as (
        select company_id, trader_id, coalesce(sum(trader_net_payable), 0) amount
          from orders where trader_settlement_status = 'unsettled' group by company_id, trader_id
      )
      select t.id, t.code, t.name_en as name, t.mobile_number as "mobileNumber",
             (t.mobile_number !~ '^9715[0-9]{8}$') as "mobileWarning",
             t.contact_person as "contactPerson", t.account_status as status,
             a.name_en as "pickupArea",
             (case when ps.trader_id is null then null else 'configured' end) as "pricingType",
             ps.rule_count as "priceRuleCount",
             ps.base_fee::text as "currentServiceFee",
             coalesce(o.amount, 0)::text as "outstandingAmount",
             count(*) over ()::int as total
        from traders t
        left join areas a on a.id=t.pickup_area_id and a.company_id=t.company_id
        left join price_summary ps on ps.company_id=t.company_id and ps.trader_id=t.id
        left join outstanding o on o.company_id=t.company_id and o.trader_id=t.id
       where t.company_id=${companyId}::uuid
         and (${search}='' or lower(t.code) like ${`%${search}%`}
              or lower(t.name_en) like ${`%${search}%`}
              or lower(coalesce(t.name_ar,'')) like ${`%${search}%`}
              or t.mobile_number like ${`%${search}%`})
         and (${status}::text is null or t.account_status=${status})
         and (${areaId}::uuid is null or t.pickup_area_id=${areaId}::uuid)
         and (${pricingType}::text is null
              or (${pricingType}='not_configured' and ps.trader_id is null)
              or (${pricingType}='configured' and ps.trader_id is not null))
       order by ${sql.raw(sort)} ${sql.raw(direction)}, t.id
       limit ${pageSize} offset ${offset}
    `.execute(this.database);
    return { items: result.rows, page, pageSize, total: result.rows[0]?.total ?? 0 };
  }

  public async trader(code: string): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const trader = await sql<Record<string, unknown>>`
      select t.id,t.code,t.name_en as name,t.name_ar as "legacyArabicName",
             t.contact_person as "contactPerson",t.mobile_number as "mobileNumber",
             t.second_mobile_number as "secondMobileNumber",t.email,
             t.commercial_number as "commercialNumber",
             t.tax_registration_number as "taxRegistrationNumber",
             t.pickup_area_id as "pickupAreaId",a.name_en as "pickupArea",
             t.pickup_address as "pickupAddress",t.location_link as "locationLink",
             t.latitude::text,t.longitude::text,t.notes,t.account_status as status,
             (t.mobile_number !~ '^9715[0-9]{8}$') as "mobileWarning",
             t.created_at::text as "createdAt",creator.username as "createdBy"
        from traders t
        left join areas a on a.id=t.pickup_area_id and a.company_id=t.company_id
        left join accounts creator on creator.id=t.created_by_account_id
       where t.company_id=${companyId}::uuid and lower(t.code)=lower(${code})
    `.execute(this.database);
    const profile = trader.rows[0];
    if (profile === undefined) this.notFound();
    const traderId = String(profile!.id);
    const [pricing, banks, orders, settlements, audit] = await Promise.all([
      this.pricingHistory(traderId),
      this.bankAccounts(traderId),
      this.relatedOrders(traderId, 1, 10),
      this.settlementSummary(traderId),
      this.auditHistory(traderId),
    ]);
    return { ...profile, pricing, banks, orders, settlements, audit };
  }

  public async create(
    input: CreateConfiguredTraderDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      await this.validateArea(transaction, companyId, input.pickupAreaId);
      const code = await this.nextCode(transaction, companyId, "trader", "TRD");
      const accountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status,password_changed_at)
        values(${accountId}::uuid,${companyId}::uuid,'trader',${`trader.${code.toLowerCase()}`},
        ${await this.passwords.hash(randomUUID())},'active',now())`.execute(transaction);
      const result = await sql<Record<string, unknown>>`
        insert into traders(company_id,account_id,code,name_en,contact_person,mobile_number,
          second_mobile_number,email,commercial_number,tax_registration_number,pickup_area_id,
          pickup_address,location_link,latitude,longitude,notes,created_by_account_id)
        values(${companyId}::uuid,${accountId}::uuid,${code},${input.name.trim()},
          ${input.contactPerson?.trim() || null},${input.mobileNumber.trim()},
          ${input.secondMobileNumber?.trim() || null},${input.email?.trim() || null},
          ${input.commercialNumber?.trim() || null},${input.taxRegistrationNumber?.trim() || null},
          ${input.pickupAreaId ?? null}::uuid,${input.pickupAddress?.trim() || null},
          ${input.locationLink?.trim() || null},${input.latitude ?? null},${input.longitude ?? null},
          ${input.notes?.trim() || null},${actorId}::uuid)
        returning id,code,name_en as name,account_status as status
      `.execute(transaction);
      const created = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "trader.create",
        "trader",
        String(created.id),
        null,
        created,
        correlationId,
        null,
      );
      return created;
    });
  }

  public async update(
    traderId: string,
    input: UpdateConfiguredTraderDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const current = await sql<
        Record<string, unknown>
      >`select * from traders where id=${traderId}::uuid and company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      const before = current.rows[0];
      if (before === undefined) this.notFound();
      const mobile = input.mobileNumber?.trim();
      if (
        mobile !== undefined &&
        mobile !== before!.mobile_number &&
        !/^9715[0-9]{8}$/.test(mobile)
      )
        this.invalidMobile();
      const second = input.secondMobileNumber?.trim() || null;
      if (
        input.secondMobileNumber !== undefined &&
        second !== before!.second_mobile_number &&
        second !== null &&
        !/^9715[0-9]{8}$/.test(second)
      )
        this.invalidMobile();
      await this.validateArea(transaction, companyId, input.pickupAreaId ?? undefined);
      const result = await sql<Record<string, unknown>>`
        update traders set
          name_en=coalesce(${input.name?.trim() || null},name_en),
          contact_person=case when ${input.contactPerson === undefined} then contact_person else ${input.contactPerson?.trim() || null} end,
          mobile_number=coalesce(${mobile ?? null},mobile_number),
          second_mobile_number=case when ${input.secondMobileNumber === undefined} then second_mobile_number else ${second} end,
          email=case when ${input.email === undefined} then email else ${input.email?.trim() || null} end,
          commercial_number=case when ${input.commercialNumber === undefined} then commercial_number else ${input.commercialNumber?.trim() || null} end,
          tax_registration_number=case when ${input.taxRegistrationNumber === undefined} then tax_registration_number else ${input.taxRegistrationNumber?.trim() || null} end,
          pickup_area_id=case when ${input.pickupAreaId === undefined} then pickup_area_id else ${input.pickupAreaId ?? null}::uuid end,
          pickup_address=case when ${input.pickupAddress === undefined} then pickup_address else ${input.pickupAddress?.trim() || null} end,
          location_link=case when ${input.locationLink === undefined} then location_link else ${input.locationLink?.trim() || null} end,
          latitude=case when ${input.latitude === undefined} then latitude else ${input.latitude ?? null} end,
          longitude=case when ${input.longitude === undefined} then longitude else ${input.longitude ?? null} end,
          notes=case when ${input.notes === undefined} then notes else ${input.notes?.trim() || null} end,
          updated_at=now(),version=version+1
        where id=${traderId}::uuid and company_id=${companyId}::uuid
        returning id,code,name_en as name,account_status as status
      `.execute(transaction);
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "trader.update",
        "trader",
        traderId,
        before!,
        after,
        correlationId,
        null,
      );
      return after;
    });
  }

  public async changeStatus(
    traderId: string,
    input: ChangeTraderStatusDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const current = await sql<{
        accountId: string;
        status: string;
      }>`select account_id as "accountId",account_status as status from traders where id=${traderId}::uuid and company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      const before = current.rows[0];
      if (before === undefined) this.notFound();
      const status = input.isActive ? "active" : "disabled";
      const result = await sql<
        Record<string, unknown>
      >`update traders set account_status=${status},deactivated_at=case when ${input.isActive} then null else now() end,updated_at=now(),version=version+1 where id=${traderId}::uuid and company_id=${companyId}::uuid returning id,code,name_en as name,account_status as status`.execute(
        transaction,
      );
      await sql`update accounts set status=${status},updated_at=now(),version=version+1 where id=${before!.accountId}::uuid and company_id=${companyId}::uuid`.execute(
        transaction,
      );
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        input.isActive ? "trader.reactivate" : "trader.disable",
        "trader",
        traderId,
        before!,
        after,
        correlationId,
        input.reason.trim(),
      );
      return after;
    });
  }

  /**
   * Adds one price rule. Its scope is (Emirate, Area): both set is a specific
   * Area, Emirate-only is that Emirate's default, and neither set is the single
   * global price that also serves as flat pricing.
   */
  public async createPricing(
    traderId: string,
    input: CreateTraderPricingDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions
      .execute(async (transaction) => {
        const trader = await sql<{
          status: string;
        }>`select account_status as status from traders where id=${traderId}::uuid and company_id=${companyId}::uuid for update`.execute(
          transaction,
        );
        if (trader.rows[0] === undefined) this.notFound();
        if (trader.rows[0]!.status !== "active")
          throw new ApplicationException(
            "trader_disabled",
            "Disabled Traders cannot receive new pricing",
            HttpStatus.CONFLICT,
          );
        const { areaId, emirateId } = await this.resolvePriceScope(transaction, companyId, input);
        const reason = input.reason?.trim() || null;
        const inserted = await sql<{ id: string }>`
          insert into trader_service_prices
            (company_id, trader_id, emirate_id, area_id, service_fee, reason, created_by_account_id)
          values (${companyId}::uuid, ${traderId}::uuid, ${emirateId}::uuid, ${areaId}::uuid,
                  ${input.serviceFee}, ${reason}, ${actorId}::uuid)
          returning id
        `.execute(transaction);
        const id = inserted.rows[0]!.id;
        const after = { areaId, emirateId, id, serviceFee: input.serviceFee };
        await this.audit(
          transaction,
          companyId,
          actorId,
          "trader_pricing.create",
          "trader_service_price",
          id,
          null,
          after,
          correlationId,
          reason,
        );
        return after;
      })
      .catch((error: unknown) => {
        throw this.mapPricingError(error);
      });
  }

  /** Edits an existing price rule's fee and reason, keeping its scope fixed. */
  public async updatePricing(
    traderId: string,
    priceId: string,
    input: UpdateTraderPricingDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const before = await sql<{ reason: string | null; serviceFee: string }>`
        select service_fee::text as "serviceFee", reason from trader_service_prices
         where id=${priceId}::uuid and trader_id=${traderId}::uuid and company_id=${companyId}::uuid
         for update
      `.execute(transaction);
      if (before.rows[0] === undefined)
        throw new ApplicationException(
          "pricing_not_found",
          "The pricing rule was not found",
          HttpStatus.NOT_FOUND,
        );
      const reason = input.reason?.trim() || null;
      await sql`
        update trader_service_prices
           set service_fee=${input.serviceFee}, reason=${reason},
               updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
         where id=${priceId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      const after = { id: priceId, serviceFee: input.serviceFee };
      await this.audit(
        transaction,
        companyId,
        actorId,
        "trader_pricing.update",
        "trader_service_price",
        priceId,
        before.rows[0],
        after,
        correlationId,
        reason,
      );
      return after;
    });
  }

  /** Validates and normalises the (Emirate, Area) scope of a price rule. */
  private async resolvePriceScope(
    transaction: Transaction,
    companyId: string,
    input: { areaId?: string; emirateId?: string },
  ): Promise<{ areaId: string | null; emirateId: string | null }> {
    const emirateId = input.emirateId ?? null;
    const areaId = input.areaId ?? null;
    if (areaId !== null && emirateId === null)
      throw new ApplicationException(
        "pricing_area_needs_emirate",
        "Choose an Emirate before selecting an Area",
        HttpStatus.BAD_REQUEST,
      );
    if (emirateId !== null) {
      const emirate = await sql`
        select id from emirates where id=${emirateId}::uuid and is_active
      `.execute(transaction);
      if (emirate.rows[0] === undefined)
        throw new ApplicationException(
          "emirate_not_found",
          "The selected Emirate does not exist",
          HttpStatus.BAD_REQUEST,
        );
    }
    if (areaId !== null) await this.validateArea(transaction, companyId, areaId);
    return { areaId, emirateId };
  }

  /** Turns Postgres constraint violations into stable, non-leaking errors. */
  private mapPricingError(error: unknown): unknown {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "23505")
      return new ApplicationException(
        "pricing_scope_exists",
        "A price already exists for this Emirate and Area. Edit the existing one instead.",
        HttpStatus.CONFLICT,
      );
    if (code === "23514")
      return new ApplicationException(
        "pricing_invalid_scope",
        "The selected Area does not belong to the selected Emirate",
        HttpStatus.BAD_REQUEST,
      );
    return error;
  }

  public async bankAccounts(traderId: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<
      Record<string, unknown>
    >`select id,bank_name as "bankName",account_name as "accountName",account_number as "accountNumber",iban,swift_code as "swiftCode",currency,is_active as "isActive",is_default as "isDefault",notes,created_at::text as "createdAt" from trader_bank_accounts where company_id=${companyId}::uuid and trader_id=${traderId}::uuid order by is_active desc,is_default desc,created_at desc`.execute(
      this.database,
    );
    return result.rows;
  }

  public async createBank(
    traderId: string,
    input: SaveTraderBankAccountDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      await this.requireTrader(transaction, companyId, traderId);
      if (input.isDefault)
        await sql`update trader_bank_accounts set is_default=false,updated_at=now(),version=version+1 where company_id=${companyId}::uuid and trader_id=${traderId}::uuid and is_default`.execute(
          transaction,
        );
      const result = await sql<
        Record<string, unknown>
      >`insert into trader_bank_accounts(company_id,trader_id,bank_name,account_name,account_number,iban,swift_code,is_default,notes,created_by_account_id)
        values(${companyId}::uuid,${traderId}::uuid,${input.bankName.trim()},${input.accountName.trim()},${input.accountNumber.trim()},${input.iban.trim().toUpperCase()},${input.swiftCode?.trim().toUpperCase() || null},${input.isDefault ?? false},${input.notes?.trim() || null},${actorId}::uuid)
        returning id,bank_name as "bankName",account_name as "accountName",iban,is_active as "isActive",is_default as "isDefault"`.execute(
        transaction,
      );
      const account = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "trader_bank_account.create",
        "trader_bank_account",
        String(account.id),
        null,
        account,
        correlationId,
        null,
      );
      return account;
    });
  }

  public async updateBank(
    traderId: string,
    bankId: string,
    input: SaveTraderBankAccountDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const current = await sql<
        Record<string, unknown>
      >`select * from trader_bank_accounts where id=${bankId}::uuid and trader_id=${traderId}::uuid and company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      const before = current.rows[0];
      if (before === undefined)
        throw new ApplicationException(
          "trader_bank_not_found",
          "Trader bank account not found",
          HttpStatus.NOT_FOUND,
        );
      if (input.isDefault)
        await sql`update trader_bank_accounts set is_default=false,updated_at=now(),version=version+1 where company_id=${companyId}::uuid and trader_id=${traderId}::uuid and id<>${bankId}::uuid and is_default`.execute(
          transaction,
        );
      const result = await sql<
        Record<string, unknown>
      >`update trader_bank_accounts set bank_name=${input.bankName.trim()},account_name=${input.accountName.trim()},account_number=${input.accountNumber.trim()},iban=${input.iban.trim().toUpperCase()},swift_code=${input.swiftCode?.trim().toUpperCase() || null},is_default=${input.isDefault ?? Boolean(before.is_default)},notes=${input.notes?.trim() || null},updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1 where id=${bankId}::uuid and company_id=${companyId}::uuid returning id,bank_name as "bankName",account_name as "accountName",iban,is_active as "isActive",is_default as "isDefault"`.execute(
        transaction,
      );
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "trader_bank_account.update",
        "trader_bank_account",
        bankId,
        before,
        after,
        correlationId,
        null,
      );
      return after;
    });
  }

  public async changeBankStatus(
    traderId: string,
    bankId: string,
    input: ChangeTraderBankStatusDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const current = await sql<
        Record<string, unknown>
      >`select id,is_active,is_default from trader_bank_accounts where id=${bankId}::uuid and trader_id=${traderId}::uuid and company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      const before = current.rows[0];
      if (before === undefined)
        throw new ApplicationException(
          "trader_bank_not_found",
          "Trader bank account not found",
          HttpStatus.NOT_FOUND,
        );
      const makeDefault = input.isActive && (input.isDefault ?? Boolean(before.is_default));
      if (makeDefault)
        await sql`update trader_bank_accounts set is_default=false,updated_at=now(),version=version+1 where company_id=${companyId}::uuid and trader_id=${traderId}::uuid and id<>${bankId}::uuid and is_default`.execute(
          transaction,
        );
      const result = await sql<
        Record<string, unknown>
      >`update trader_bank_accounts set is_active=${input.isActive},is_default=${makeDefault},disabled_at=case when ${input.isActive} then null else now() end,updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1 where id=${bankId}::uuid and company_id=${companyId}::uuid returning id,is_active as "isActive",is_default as "isDefault"`.execute(
        transaction,
      );
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "trader_bank_account.status",
        "trader_bank_account",
        bankId,
        before,
        after,
        correlationId,
        input.reason.trim(),
      );
      return after;
    });
  }

  public async relatedOrders(
    traderId: string,
    page: number,
    pageSize: number,
  ): Promise<TraderPage<Record<string, unknown>>> {
    const { companyId } = this.tenants.current();
    const safePage = Math.max(page || 1, 1),
      safeSize = Math.min(Math.max(pageSize || 10, 1), 100);
    const result = await sql<
      Record<string, unknown> & { total: number }
    >`select o.id,o.order_number as "orderNumber",o.order_date::text as "orderDate",o.customer_name as customer,a.name_en as area,o.customer_amount_due::text as "amountToCollect",o.service_fee::text as "serviceFee",o.delivery_status as "deliveryStatus",o.driver_reconciliation_status as "driverCashStatus",o.trader_settlement_status as "traderSettlementStatus",count(*) over()::int total from orders o join areas a on a.id=o.area_id and a.company_id=o.company_id where o.company_id=${companyId}::uuid and o.trader_id=${traderId}::uuid order by o.order_date desc,o.order_number desc limit ${safeSize} offset ${(safePage - 1) * safeSize}`.execute(
      this.database,
    );
    return {
      items: result.rows,
      page: safePage,
      pageSize: safeSize,
      total: result.rows[0]?.total ?? 0,
    };
  }

  /**
   * The Trader's price rules, ordered global first, then each Emirate's default,
   * then its specific Areas — the same order the fee resolution reads them.
   */
  private async pricingHistory(traderId: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<Record<string, unknown>>`
      select p.id,
             e.id as "emirateId", e.name_en as "emirateNameEn", e.name_ar as "emirateNameAr",
             a.id as "areaId", a.name_en as "areaNameEn", a.name_ar as "areaNameAr",
             p.service_fee::text as "serviceFee",
             p.reason,
             creator.username as "createdBy",
             updater.username as "updatedBy",
             p.updated_at::text as "updatedAt"
        from trader_service_prices p
        left join emirates e on e.id=p.emirate_id
        left join areas a on a.id=p.area_id and a.company_id=p.company_id
        join accounts creator on creator.id=p.created_by_account_id
        left join accounts updater on updater.id=p.updated_by_account_id
       where p.company_id=${companyId}::uuid and p.trader_id=${traderId}::uuid
       order by (p.emirate_id is not null), e.display_order, (p.area_id is not null), a.name_en
    `.execute(this.database);
    return result.rows;
  }

  private async settlementSummary(traderId: string): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const [summary, history] = await Promise.all([
      sql<Record<string, unknown>>`select
        coalesce((select sum(o.trader_net_payable) from orders o where o.company_id=t.company_id and o.trader_id=t.id and o.trader_settlement_status='unsettled'),0)::text as "outstandingAmount",
        (select count(*)::int from orders o where o.company_id=t.company_id and o.trader_id=t.id and o.trader_settlement_status='unsettled') as "unsettledOrders",
        coalesce((select sum(s.net_payable) from trader_settlements s where s.company_id=t.company_id and s.trader_id=t.id and s.status='confirmed'),0)::text as "moneySent",
        (select max(s.confirmed_at)::text from trader_settlements s where s.company_id=t.company_id and s.trader_id=t.id) as "lastSettlementDate"
        from traders t where t.company_id=${companyId}::uuid and t.id=${traderId}::uuid`.execute(
        this.database,
      ),
      sql<
        Record<string, unknown>
      >`select s.id,s.settlement_number as "settlementNumber",s.business_date::text as "businessDate",s.net_payable::text as "netPayable",s.status,s.confirmed_at::text as "confirmedAt",p.payment_method as "paymentMethod",p.bank_reference as "bankReference",p.trader_bank_account_snapshot as "beneficiarySnapshot" from trader_settlements s left join trader_settlement_payments p on p.settlement_id=s.id and p.company_id=s.company_id where s.company_id=${companyId}::uuid and s.trader_id=${traderId}::uuid order by s.business_date desc,s.created_at desc limit 100`.execute(
        this.database,
      ),
    ]);
    return {
      ...(summary.rows[0] ?? {
        outstandingAmount: "0",
        unsettledOrders: 0,
        moneySent: "0",
        lastSettlementDate: null,
      }),
      history: history.rows,
    };
  }

  private async auditHistory(traderId: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<
      Record<string, unknown>
    >`select e.id,e.action as "eventType",e.subject_type as "entityType",e.subject_id as "entityId",e.before_data as "previousValue",e.after_data as "newValue",a.username as actor,e.actor_role as "actorRole",e.occurred_at::text as "occurredAt",e.source,e.reason,e.correlation_id as "correlationId" from audit_events e left join accounts a on a.id=e.actor_account_id where e.company_id=${companyId}::uuid and (e.subject_id=${traderId} or e.subject_id in (select id::text from trader_service_prices where company_id=${companyId}::uuid and trader_id=${traderId}::uuid) or e.subject_id in (select id::text from trader_bank_accounts where company_id=${companyId}::uuid and trader_id=${traderId}::uuid)) order by e.occurred_at desc limit 200`.execute(
      this.database,
    );
    return result.rows;
  }

  private async nextCode(
    transaction: Transaction,
    companyId: string,
    type: "area" | "trader",
    prefix: "AREA" | "TRD",
  ): Promise<string> {
    const result = await sql<{
      nextValue: string;
      prefix: string;
    }>`insert into company_reference_counters(company_id,reference_type,next_value,prefix) values(${companyId}::uuid,${type},2,${prefix}) on conflict(company_id,reference_type) do update set next_value=company_reference_counters.next_value+1,updated_at=now() returning prefix,(next_value-1)::text as "nextValue"`.execute(
      transaction,
    );
    const counter = result.rows[0]!;
    return `${counter.prefix}-${counter.nextValue.padStart(6, "0")}`;
  }

  private async validateArea(
    transaction: Transaction,
    companyId: string,
    areaId?: string,
  ): Promise<void> {
    if (areaId === undefined) return;
    const result =
      await sql`select id from areas where id=${areaId}::uuid and company_id=${companyId}::uuid and is_active`.execute(
        transaction,
      );
    if (result.rows[0] === undefined)
      throw new ApplicationException(
        "area_not_found",
        "The selected Area is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
  }

  private async requireTrader(
    transaction: Transaction,
    companyId: string,
    traderId: string,
  ): Promise<void> {
    const result =
      await sql`select id from traders where id=${traderId}::uuid and company_id=${companyId}::uuid`.execute(
        transaction,
      );
    if (result.rows[0] === undefined) this.notFound();
  }

  private async audit(
    transaction: Transaction,
    companyId: string,
    actorId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    before: object | null,
    after: object | null,
    correlationId: string,
    reason: string | null,
  ): Promise<void> {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,reason,before_data,after_data,correlation_id,actor_role,source) values(${companyId}::uuid,${actorId}::uuid,${action},${subjectType},${subjectId},${reason},${before === null ? null : JSON.stringify(before)}::jsonb,${after === null ? null : JSON.stringify(after)}::jsonb,${correlationId},'Company Administrator','web_portal')`.execute(
      transaction,
    );
  }

  private notFound(): never {
    throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
  }

  private invalidMobile(): never {
    throw new ApplicationException(
      "trader_mobile_invalid",
      "Enter the mobile number in the format 9715XXXXXXXX.",
      HttpStatus.BAD_REQUEST,
    );
  }
}
