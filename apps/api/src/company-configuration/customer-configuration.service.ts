import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { normalizeUaeMobile } from "../shared/uae-mobile.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type {
  ChangeCustomerAddressStatusDto,
  ChangeCustomerStatusDto,
  CreateCustomerDto,
  CustomerAddressDto,
  UpdateCustomerAddressDto,
  UpdateCustomerDto,
} from "./customer-configuration.dto.js";

type Transaction = Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0];

export interface CustomerPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface CustomerSummary {
  readonly area: string | null;
  readonly code: string;
  readonly id: string;
  readonly lastOrderDate: string | null;
  readonly mobileNumber: string;
  readonly name: string;
  readonly orderCount: number;
  readonly primaryAddress: string | null;
  readonly status: "active" | "disabled";
}

/**
 * Word-by-word search: every whitespace/dash-separated word in the term must
 * appear in the Customer's code, name, or either mobile number. Matches the
 * "CODE - name - mobile" label the picker shows after a selection, and any mix
 * of words in any order. An empty term matches everyone.
 */
function customerSearchMatch(term: string): ReturnType<typeof sql> {
  const haystack = sql`lower(c.code || ' ' || c.name || ' ' || c.mobile_number || ' ' || coalesce(c.second_mobile_number, ''))`;
  const tokens = term.split(/[\s-]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return sql`true`;
  return sql.join(
    tokens.map((token) => sql`${haystack} like ${`%${token}%`}`),
    sql` and `,
  );
}

@Injectable()
export class CustomerConfigurationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async customers(query: Record<string, string>): Promise<CustomerPage<CustomerSummary>> {
    const { companyId } = this.tenants.current();
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = [25, 50, 100].includes(Number(query.pageSize)) ? Number(query.pageSize) : 25;
    const rawSearch = query.search?.trim() ?? "";
    const search = normalizeUaeMobile(rawSearch) ?? rawSearch.toLowerCase();
    const status =
      query.status === "disabled" ? "disabled" : query.status === "all" ? null : "active";
    const areaId = query.areaId?.trim() || null;
    const traderId = query.traderId?.trim() || null;
    const activity =
      query.activity === "has_orders" || query.activity === "no_orders" ? query.activity : null;
    const sortColumns: Record<string, string> = {
      code: "c.code",
      lastOrderDate: "stats.last_order_date",
      mobile: "c.mobile_number",
      name: "c.name",
      orderCount: "stats.order_count",
      status: "c.status",
    };
    const sort = sortColumns[query.sortBy ?? "name"] ?? sortColumns.name!;
    const direction = query.sortDirection === "desc" ? "desc" : "asc";
    const result = await sql<CustomerSummary & { total: number }>`
      select c.id,c.code,c.name,c.mobile_number as "mobileNumber",c.status,
             address.address as "primaryAddress",area.name_en as area,
             coalesce(stats.order_count,0)::int as "orderCount",
             stats.last_order_date::text as "lastOrderDate",count(*) over()::int total
        from customers c
        left join lateral (
          select ca.address,ca.area_id from customer_addresses ca
           where ca.company_id=c.company_id and ca.customer_id=c.id and ca.is_active
           order by ca.is_default desc,ca.created_at limit 1
        ) address on true
        left join areas area on area.id=address.area_id and area.company_id=c.company_id
        left join lateral (
          select count(*)::int order_count,max(o.order_date) last_order_date
            from orders o where o.company_id=c.company_id and o.customer_id=c.id
        ) stats on true
       where c.company_id=${companyId}::uuid
         and (${status}::text is null or c.status=${status})
         and (${search}='' or lower(c.code) like ${`%${search}%`}
              or lower(c.name) like ${`%${search}%`}
              or c.mobile_number like ${`%${search}%`}
              or coalesce(c.second_mobile_number,'') like ${`%${search}%`})
         and (${areaId}::uuid is null or exists(
           select 1 from customer_addresses ca where ca.company_id=c.company_id
             and ca.customer_id=c.id and ca.area_id=${areaId}::uuid and ca.is_active
         ))
         and (${traderId}::uuid is null or exists(
           select 1 from orders o where o.company_id=c.company_id
             and o.customer_id=c.id and o.trader_id=${traderId}::uuid
         ))
         and (${activity}::text is null
              or (${activity}='has_orders' and coalesce(stats.order_count,0)>0)
              or (${activity}='no_orders' and coalesce(stats.order_count,0)=0))
       order by ${sql.raw(sort)} ${sql.raw(direction)} nulls last,c.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    return { items: result.rows, page, pageSize, total: result.rows[0]?.total ?? 0 };
  }

  public async search(query: Record<string, string>): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const search = query.search?.trim().toLowerCase() ?? "";
    const result = await sql<Record<string, unknown> & { total: number }>`
      select c.id,c.code,c.name,c.mobile_number as "mobileNumber",
             c.second_mobile_number as "secondMobileNumber",c.email,
             c.customer_reference as "customerReference",c.delivery_notes as "deliveryNotes",
             ca.id as "addressId",ca.address,ca.area_id as "areaId",a.code as "areaCode",
             a.name_en as "areaName",a.name_ar as "areaNameAr",
             e.id as "emirateId",e.name_en as "emirateNameEn",e.name_ar as "emirateNameAr",
             ca.location_link as "locationLink",
             ca.latitude::text,ca.longitude::text,
             ca.delivery_instructions as "deliveryInstructions",count(*) over()::int total
        from customers c
        join lateral (
          select * from customer_addresses x where x.company_id=c.company_id
            and x.customer_id=c.id and x.is_active
          order by x.is_default desc,x.created_at limit 1
        ) ca on true
        join areas a on a.id=ca.area_id and a.company_id=c.company_id and a.is_active
        join emirates e on e.id=a.emirate_id
       where c.company_id=${companyId}::uuid and c.status='active'
         and (${customerSearchMatch(search)})
       order by c.name,c.code limit ${limit + 1} offset ${offset}
    `.execute(this.database);
    return {
      hasMore: result.rows.length > limit,
      items: result.rows.slice(0, limit),
      limit,
      offset,
    };
  }

  public async customer(code: string): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const result = await sql<Record<string, unknown>>`
      select c.id,c.code,c.name,c.mobile_number as "mobileNumber",
             c.second_mobile_number as "secondMobileNumber",c.email,
             c.customer_reference as "customerReference",c.delivery_notes as "deliveryNotes",
             c.internal_notes as "internalNotes",c.status,c.created_at::text as "createdAt",
             creator.username as "createdBy"
        from customers c left join accounts creator on creator.id=c.created_by_account_id
       where c.company_id=${companyId}::uuid and lower(c.code)=lower(${code})
    `.execute(this.database);
    const profile = result.rows[0];
    if (profile === undefined) this.notFound();
    const customerId = String(profile!.id);
    const [addresses, orders, metrics, audit] = await Promise.all([
      this.addresses(customerId),
      this.relatedOrders(customerId, 1, 10),
      this.metrics(customerId),
      this.auditHistory(customerId),
    ]);
    return { ...profile, addresses, orders, metrics, audit };
  }

  public async create(
    input: CreateCustomerDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    this.validateCoordinates(input.latitude, input.longitude);
    this.validateMobiles(input.mobileNumber, input.secondMobileNumber);
    return this.transactions.execute(async (transaction) => {
      await this.validateArea(transaction, companyId, input.areaId);
      await sql`select pg_advisory_xact_lock(hashtext(${companyId}),hashtext(${input.mobileNumber}))`.execute(
        transaction,
      );
      const duplicates = await this.findDuplicates(
        transaction,
        companyId,
        input.mobileNumber,
        input.secondMobileNumber,
      );
      if (duplicates.length > 0 && !input.duplicateOverrideReason?.trim()) {
        throw new ApplicationException(
          "customer_duplicate",
          "A Customer with this mobile number already exists",
          HttpStatus.CONFLICT,
          duplicates.map((row) => `${String(row.code)} - ${String(row.name)}`),
        );
      }
      const code = await this.nextCode(transaction, companyId);
      const created = await sql<Record<string, unknown>>`
        insert into customers(company_id,code,name,mobile_number,second_mobile_number,email,
          customer_reference,delivery_notes,internal_notes,created_by_account_id)
        values(${companyId}::uuid,${code},${input.name.trim()},${input.mobileNumber.trim()},
          ${input.secondMobileNumber?.trim() || null},${input.email?.trim() || null},
          ${input.customerReference?.trim() || null},${input.deliveryNotes?.trim() || null},
          ${input.internalNotes?.trim() || null},${actorId}::uuid)
        returning id,code,name,mobile_number as "mobileNumber",status
      `.execute(transaction);
      const customer = created.rows[0]!;
      const address = await this.insertAddress(
        transaction,
        companyId,
        actorId,
        String(customer.id),
        input,
        true,
      );
      await this.audit(
        transaction,
        companyId,
        actorId,
        "customer.create",
        "customer",
        String(customer.id),
        null,
        customer,
        null,
        correlationId,
        input.source ?? "customer_configuration",
      );
      await this.audit(
        transaction,
        companyId,
        actorId,
        "customer_address.create",
        "customer_address",
        String(address.id),
        null,
        address,
        null,
        correlationId,
        input.source ?? "customer_configuration",
      );
      if (duplicates.length > 0) {
        await this.audit(
          transaction,
          companyId,
          actorId,
          "customer.duplicate_override",
          "customer",
          String(customer.id),
          { matches: duplicates },
          customer,
          input.duplicateOverrideReason!.trim(),
          correlationId,
          input.source ?? "customer_configuration",
        );
      }
      return { ...customer, address };
    });
  }

  public async update(
    customerId: string,
    input: UpdateCustomerDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const before = await this.requireCustomer(transaction, companyId, customerId);
      const mobile = input.mobileNumber?.trim();
      const second = input.secondMobileNumber === null ? null : input.secondMobileNumber?.trim();
      if (mobile !== undefined || second !== undefined) {
        this.validateMobiles(
          mobile ?? String(before.mobileNumber),
          second ?? (before.secondMobileNumber as string | null),
        );
        const duplicates = await this.findDuplicates(
          transaction,
          companyId,
          mobile ?? String(before.mobileNumber),
          second ?? undefined,
          customerId,
        );
        if (duplicates.length > 0)
          throw new ApplicationException(
            "customer_duplicate",
            "Another Customer uses this mobile number",
            HttpStatus.CONFLICT,
          );
      }
      const result = await sql<Record<string, unknown>>`
        update customers set
          name=coalesce(${input.name?.trim() ?? null},name),
          mobile_number=coalesce(${mobile ?? null},mobile_number),
          second_mobile_number=case when ${input.secondMobileNumber === undefined} then second_mobile_number else ${second ?? null} end,
          email=case when ${input.email === undefined} then email else ${input.email?.trim() || null} end,
          customer_reference=case when ${input.customerReference === undefined} then customer_reference else ${input.customerReference?.trim() || null} end,
          delivery_notes=case when ${input.deliveryNotes === undefined} then delivery_notes else ${input.deliveryNotes?.trim() || null} end,
          internal_notes=case when ${input.internalNotes === undefined} then internal_notes else ${input.internalNotes?.trim() || null} end,
          updated_at=now(),version=version+1
        where id=${customerId}::uuid and company_id=${companyId}::uuid
        returning id,code,name,mobile_number as "mobileNumber",second_mobile_number as "secondMobileNumber",
          email,customer_reference as "customerReference",delivery_notes as "deliveryNotes",
          internal_notes as "internalNotes",status
      `.execute(transaction);
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "customer.update",
        "customer",
        customerId,
        before,
        after,
        null,
        correlationId,
        "customer_configuration",
      );
      return after;
    });
  }

  public async changeStatus(
    customerId: string,
    input: ChangeCustomerStatusDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const status = input.isActive ? "active" : "disabled";
    return this.transactions.execute(async (transaction) => {
      const before = await this.requireCustomer(transaction, companyId, customerId);
      const result = await sql<Record<string, unknown>>`
        update customers set status=${status},deactivated_at=${input.isActive ? null : sql`now()`},
          updated_at=now(),version=version+1
        where id=${customerId}::uuid and company_id=${companyId}::uuid
        returning id,code,name,status
      `.execute(transaction);
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        input.isActive ? "customer.reactivate" : "customer.disable",
        "customer",
        customerId,
        before,
        after,
        input.reason.trim(),
        correlationId,
        "customer_configuration",
      );
      return after;
    });
  }

  public async addresses(customerId: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    await this.requireCustomer(this.database, companyId, customerId);
    const result = await sql<Record<string, unknown>>`
      select ca.id,ca.label,ca.address,ca.area_id as "areaId",a.code as "areaCode",
             a.name_en as "areaName",ca.location_link as "locationLink",ca.latitude::text,
             ca.longitude::text,ca.delivery_instructions as "deliveryInstructions",
             ca.is_default as "isDefault",ca.is_active as "isActive",ca.created_at::text as "createdAt",
             creator.username as "createdBy"
        from customer_addresses ca join areas a on a.id=ca.area_id and a.company_id=ca.company_id
        left join accounts creator on creator.id=ca.created_by_account_id
       where ca.company_id=${companyId}::uuid and ca.customer_id=${customerId}::uuid
       order by ca.is_active desc,ca.is_default desc,ca.created_at
    `.execute(this.database);
    return result.rows;
  }

  public async createAddress(
    customerId: string,
    input: CustomerAddressDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    this.validateCoordinates(input.latitude, input.longitude);
    return this.transactions.execute(async (transaction) => {
      await this.requireCustomer(transaction, companyId, customerId);
      await this.validateArea(transaction, companyId, input.areaId);
      const count = await sql<{
        count: number;
      }>`select count(*)::int count from customer_addresses where company_id=${companyId}::uuid and customer_id=${customerId}::uuid and is_active`.execute(
        transaction,
      );
      const makeDefault = input.isDefault === true || (count.rows[0]?.count ?? 0) === 0;
      if (makeDefault) await this.clearDefault(transaction, companyId, customerId);
      const address = await this.insertAddress(
        transaction,
        companyId,
        actorId,
        customerId,
        input,
        makeDefault,
      );
      await this.audit(
        transaction,
        companyId,
        actorId,
        "customer_address.create",
        "customer_address",
        String(address.id),
        null,
        address,
        null,
        correlationId,
        "customer_configuration",
      );
      return address;
    });
  }

  public async updateAddress(
    customerId: string,
    addressId: string,
    input: UpdateCustomerAddressDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    this.validateCoordinates(input.latitude, input.longitude);
    return this.transactions.execute(async (transaction) => {
      await this.requireCustomer(transaction, companyId, customerId);
      await this.validateArea(transaction, companyId, input.areaId);
      const before = await this.requireAddress(transaction, companyId, customerId, addressId);
      if (input.isActive !== undefined && input.isActive !== Boolean(before.isActive)) {
        throw new ApplicationException(
          "customer_address_status_workflow_required",
          "Use the address status action to disable or reactivate an address",
          HttpStatus.CONFLICT,
        );
      }
      if (Boolean(before.isDefault) && input.isDefault === false) {
        throw new ApplicationException(
          "customer_default_address_required",
          "Select another address as default before changing this default address",
          HttpStatus.CONFLICT,
        );
      }
      if (input.isDefault) await this.clearDefault(transaction, companyId, customerId);
      const result = await sql<Record<string, unknown>>`
        update customer_addresses set area_id=${input.areaId}::uuid,label=${input.label?.trim() || null},
          address=${input.address.trim()},location_link=${input.locationLink?.trim() || null},
          latitude=${input.latitude ?? null},longitude=${input.longitude ?? null},
          delivery_instructions=${input.deliveryInstructions?.trim() || null},
          is_default=${input.isDefault ?? Boolean(before.isDefault)},
          is_active=${input.isActive ?? Boolean(before.isActive)},updated_at=now(),version=version+1
        where id=${addressId}::uuid and company_id=${companyId}::uuid and customer_id=${customerId}::uuid
        returning id,address,area_id as "areaId",is_default as "isDefault",is_active as "isActive"
      `.execute(transaction);
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        "customer_address.update",
        "customer_address",
        addressId,
        before,
        after,
        input.reason.trim(),
        correlationId,
        "customer_configuration",
      );
      return after;
    });
  }

  public async changeAddressStatus(
    customerId: string,
    addressId: string,
    input: ChangeCustomerAddressStatusDto,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const before = await this.requireAddress(transaction, companyId, customerId, addressId);
      if (!input.isActive && Boolean(before.isDefault)) {
        const replacement = await sql<{
          id: string;
        }>`select id from customer_addresses where company_id=${companyId}::uuid and customer_id=${customerId}::uuid and id<>${addressId}::uuid and is_active order by created_at limit 1`.execute(
          transaction,
        );
        if (replacement.rows[0] === undefined)
          throw new ApplicationException(
            "customer_address_required",
            "A Customer must retain an active address",
            HttpStatus.CONFLICT,
          );
        await this.clearDefault(transaction, companyId, customerId);
        await sql`update customer_addresses set is_default=true,updated_at=now(),version=version+1 where id=${replacement.rows[0].id}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
      } else if (input.isActive && input.isDefault) {
        await this.clearDefault(transaction, companyId, customerId);
      }
      const result = await sql<Record<string, unknown>>`
        update customer_addresses set is_active=${input.isActive},
          is_default=${input.isActive && input.isDefault === true},
          deactivated_at=${input.isActive ? null : sql`now()`},updated_at=now(),version=version+1
        where id=${addressId}::uuid and company_id=${companyId}::uuid and customer_id=${customerId}::uuid
        returning id,address,is_default as "isDefault",is_active as "isActive"
      `.execute(transaction);
      const after = result.rows[0]!;
      await this.audit(
        transaction,
        companyId,
        actorId,
        input.isActive ? "customer_address.reactivate" : "customer_address.disable",
        "customer_address",
        addressId,
        before,
        after,
        input.reason.trim(),
        correlationId,
        "customer_configuration",
      );
      return after;
    });
  }

  public async relatedOrders(
    customerId: string,
    pageInput: number,
    pageSizeInput: number,
  ): Promise<CustomerPage<Record<string, unknown>>> {
    const { companyId } = this.tenants.current();
    await this.requireCustomer(this.database, companyId, customerId);
    const page = Math.max(pageInput || 1, 1);
    const pageSize = Math.min(Math.max(pageSizeInput || 10, 1), 100);
    const result = await sql<Record<string, unknown> & { total: number }>`
      select o.id,o.order_number as "orderNumber",o.order_date::text as "orderDate",
             t.code as "traderCode",t.name_en as trader,o.customer_area_name_snapshot as area,
             o.customer_address as "addressSnapshot",o.customer_amount_due::text as "amountToCollect",
             d.name_en as "assignedDriver",o.delivery_status as "deliveryStatus",
             o.driver_reconciliation_status as "driverCashStatus",
             o.trader_settlement_status as "traderSettlementStatus",count(*) over()::int total
        from orders o join traders t on t.id=o.trader_id and t.company_id=o.company_id
        left join drivers d on d.id=o.assigned_driver_id and d.company_id=o.company_id
       where o.company_id=${companyId}::uuid and o.customer_id=${customerId}::uuid
       order by o.order_date desc,o.order_number desc limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    return { items: result.rows, page, pageSize, total: result.rows[0]?.total ?? 0 };
  }

  private async metrics(customerId: string): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const result = await sql<Record<string, unknown>>`
      select count(*)::int as "totalOrders",count(*) filter(where delivery_status='delivered')::int as "deliveredOrders",
             count(*) filter(where delivery_status='cancelled')::int as "cancelledOrders",
             count(*) filter(where delivery_status='returned')::int as "returnedOrders",
             count(*) filter(where delivery_status not in ('delivered','cancelled','returned','closed'))::int as "activeOrders",
             max(order_date)::text as "lastOrderDate"
        from orders where company_id=${companyId}::uuid and customer_id=${customerId}::uuid
    `.execute(this.database);
    return result.rows[0] ?? {};
  }

  private async auditHistory(customerId: string): Promise<readonly Record<string, unknown>[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<Record<string, unknown>>`
      select e.id,e.action as "eventType",e.subject_type as "entityType",e.subject_id as "entityId",
             e.before_data as "previousValue",e.after_data as "newValue",a.username as actor,
             coalesce(e.actor_role,'Legacy/Unknown') as "actorRole",e.occurred_at::text as "occurredAt",
             coalesce(e.source,'Legacy/Unknown') as source,e.reason,e.correlation_id as "correlationId"
        from audit_events e left join accounts a on a.id=e.actor_account_id
       where e.company_id=${companyId}::uuid and (
         (e.subject_type='customer' and e.subject_id=${customerId})
         or (e.subject_type='customer_address' and e.subject_id in (
           select id::text from customer_addresses where company_id=${companyId}::uuid and customer_id=${customerId}::uuid
         )))
       order by e.occurred_at desc,e.id desc limit 200
    `.execute(this.database);
    return result.rows;
  }

  private async insertAddress(
    transaction: Transaction,
    companyId: string,
    actorId: string,
    customerId: string,
    input: CustomerAddressDto,
    isDefault: boolean,
  ): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      insert into customer_addresses(company_id,customer_id,area_id,label,address,location_link,
        latitude,longitude,delivery_instructions,is_default,created_by_account_id)
      values(${companyId}::uuid,${customerId}::uuid,${input.areaId}::uuid,${input.label?.trim() || null},
        ${input.address.trim()},${input.locationLink?.trim() || null},${input.latitude ?? null},
        ${input.longitude ?? null},${input.deliveryInstructions?.trim() || null},${isDefault},${actorId}::uuid)
      returning id,address,area_id as "areaId",is_default as "isDefault",is_active as "isActive"
    `.execute(transaction);
    return result.rows[0]!;
  }

  private async findDuplicates(
    database: Kysely<DatabaseSchema> | Transaction,
    companyId: string,
    mobile: string,
    secondMobile?: string | null,
    excludeId?: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await sql<Record<string, unknown>>`
      select id,code,name,mobile_number as "mobileNumber" from customers
       where company_id=${companyId}::uuid and (${excludeId ?? null}::uuid is null or id<>${excludeId ?? null}::uuid)
         and (mobile_number in (${mobile},${secondMobile ?? ""})
              or coalesce(second_mobile_number,'') in (${mobile},${secondMobile ?? ""}))
       order by name limit 10
    `.execute(database);
    return result.rows;
  }

  private validateMobiles(mobile: string, second?: string | null): void {
    if (!/^9715[0-9]{8}$/.test(mobile) || (second && !/^9715[0-9]{8}$/.test(second))) {
      throw new ApplicationException(
        "customer_mobile_invalid",
        "Enter the mobile number in the format 9715XXXXXXXX.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (second && mobile === second)
      throw new ApplicationException(
        "customer_mobile_duplicate",
        "Primary and second mobile numbers must differ",
        HttpStatus.BAD_REQUEST,
      );
  }

  private validateCoordinates(latitude?: number | null, longitude?: number | null): void {
    if (
      (latitude === undefined || latitude === null) !==
      (longitude === undefined || longitude === null)
    ) {
      throw new ApplicationException(
        "customer_coordinates_incomplete",
        "Latitude and longitude must be entered together",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async validateArea(
    database: Kysely<DatabaseSchema> | Transaction,
    companyId: string,
    areaId: string,
  ): Promise<void> {
    const result =
      await sql`select 1 from areas where id=${areaId}::uuid and company_id=${companyId}::uuid and is_active`.execute(
        database,
      );
    if (result.rows[0] === undefined)
      throw new ApplicationException(
        "area_not_found",
        "Active Area not found",
        HttpStatus.BAD_REQUEST,
      );
  }

  private async requireCustomer(
    database: Kysely<DatabaseSchema> | Transaction,
    companyId: string,
    customerId: string,
  ): Promise<Record<string, unknown>> {
    const result = await sql<
      Record<string, unknown>
    >`select id,code,name,mobile_number as "mobileNumber",second_mobile_number as "secondMobileNumber",status from customers where id=${customerId}::uuid and company_id=${companyId}::uuid`.execute(
      database,
    );
    if (result.rows[0] === undefined) this.notFound();
    return result.rows[0]!;
  }

  private async requireAddress(
    database: Kysely<DatabaseSchema> | Transaction,
    companyId: string,
    customerId: string,
    addressId: string,
  ): Promise<Record<string, unknown>> {
    const result = await sql<
      Record<string, unknown>
    >`select id,address,area_id as "areaId",is_default as "isDefault",is_active as "isActive" from customer_addresses where id=${addressId}::uuid and company_id=${companyId}::uuid and customer_id=${customerId}::uuid`.execute(
      database,
    );
    if (result.rows[0] === undefined)
      throw new ApplicationException(
        "customer_address_not_found",
        "Customer address not found",
        HttpStatus.NOT_FOUND,
      );
    return result.rows[0]!;
  }

  private async clearDefault(
    transaction: Transaction,
    companyId: string,
    customerId: string,
  ): Promise<void> {
    await sql`update customer_addresses set is_default=false,updated_at=now(),version=version+1 where company_id=${companyId}::uuid and customer_id=${customerId}::uuid and is_default`.execute(
      transaction,
    );
  }

  private async nextCode(transaction: Transaction, companyId: string): Promise<string> {
    const result = await sql<{
      nextValue: string;
      prefix: string;
    }>`insert into company_reference_counters(company_id,reference_type,next_value,prefix) values(${companyId}::uuid,'customer',2,'CUS') on conflict(company_id,reference_type) do update set next_value=company_reference_counters.next_value+1,updated_at=now() returning prefix,(next_value-1)::text as "nextValue"`.execute(
      transaction,
    );
    return `${result.rows[0]!.prefix}-${result.rows[0]!.nextValue.padStart(6, "0")}`;
  }

  private async audit(
    transaction: Transaction,
    companyId: string,
    actorId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    before: unknown,
    after: unknown,
    reason: string | null,
    correlationId: string,
    source: string,
  ): Promise<void> {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,reason,before_data,after_data,correlation_id,actor_role,source) values(${companyId}::uuid,${actorId}::uuid,${action},${subjectType},${subjectId},${reason},${before === null ? null : JSON.stringify(before)}::jsonb,${after === null ? null : JSON.stringify(after)}::jsonb,${correlationId},'Company Administrator',${source})`.execute(
      transaction,
    );
  }

  private notFound(): never {
    throw new ApplicationException(
      "customer_not_found",
      "Customer not found",
      HttpStatus.NOT_FOUND,
    );
  }
}
