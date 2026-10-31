import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { receivableCollectableNowSql } from "./cod-shortfall.js";
import { settlementLineActiveSql, zeroDueLineActiveSql } from "./order-correction-sql.js";
import { standardActivePredicate } from "./order-view-predicate.js";

/**
 * Trader Account / حساب التاجر (Aiman, 31 Oct 2026): one place for a
 * Trader's money instead of three screens (Trader Settlements, Trader
 * Receivables, Collections) that users found confusing.
 *
 * Read-only. The balance is the same figure the Trader account statement
 * closes on (`TraderAccountStatementService.balanceBefore` with no end
 * date): delivered and reconciled Orders' Trader payable, less standing
 * Settlement payments, less standing fee receivables, plus standing
 * collections. Positive = the Company owes the Trader; negative = the
 * Trader owes the Company.
 */
export interface TraderAccountRow {
  readonly traderId: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly isActive: boolean;
  /** Signed: positive = owed to the Trader, negative = owed by the Trader. */
  readonly balance: string;
  /** Unpaid service-charge / other receivables (part of the balance above). */
  readonly openReceivables: string;
  /** Orders still on their way (the Active Orders view). */
  readonly ordersWaiting: number;
  /** Delivered Orders whose Driver cash is not reconciled yet: not in the balance until it is. */
  readonly awaitingDriverCash: number;
  readonly lastPaymentDate: string | null;
  readonly lastPaymentNumber: string | null;
  readonly lastPaymentAmount: string | null;
  /** With a date range: paid to the Trader (SET) and collected from him (COL) in it. */
  readonly paidInPeriod: string;
  readonly collectedInPeriod: string;
}

/** One reference looked up: its Order, Trader and where it was settled (31 Oct 2026). */
export interface TraderReferenceLookupRow {
  readonly requested: string;
  readonly found: boolean;
  readonly orderNumber: string | null;
  readonly referenceNumber: string | null;
  readonly traderId: string | null;
  readonly traderCode: string | null;
  readonly traderNameEn: string | null;
  readonly traderNameAr: string | null;
  readonly orderDate: string | null;
  readonly deliveryDate: string | null;
  readonly deliveryStatus: string | null;
  readonly traderAmount: string | null;
  readonly traderOutstanding: string | null;
  /** "SET-000217 (2026-10-30)", the 0.00 invoice, or the fee and its collection. */
  readonly settledIn: readonly string[];
  readonly feeNumbers: readonly string[];
}

export type TraderDocumentKind = "settlement" | "zero_invoice" | "collection";

export interface TraderAccountDocument {
  readonly kind: TraderDocumentKind;
  readonly id: string;
  readonly number: string;
  readonly date: string;
  readonly amount: string;
  readonly orderCount: number;
  readonly reversed: boolean;
  /** The one-screen draft it was posted from, when there is one. */
  readonly draftId: string | null;
}

@Injectable()
export class TraderAccountService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async accounts(query: {
    readonly search?: string | undefined;
    readonly openOnly?: boolean | undefined;
    readonly traderId?: string | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  }): Promise<{ readonly items: readonly TraderAccountRow[]; readonly totals: { readonly owedToTraders: string; readonly owedByTraders: string } }> {
    this.assertPermission();
    const { companyId } = this.tenants.current();
    const search = query.search?.trim() || null;
    const traderId = query.traderId ?? null;
    const from = query.from ?? null;
    const to = query.to ?? null;
    if (from !== null && to !== null && from > to) {
      throw new ApplicationException("invalid_date_range", "Invalid date range", HttpStatus.BAD_REQUEST);
    }
    const rows = (
      await sql<{
        traderId: string;
        code: string;
        nameEn: string;
        nameAr: string | null;
        isActive: boolean;
        payable: string;
        paid: string;
        receivables: string;
        collected: string;
        openReceivables: string;
        ordersWaiting: number;
        awaitingDriverCash: number;
        lastPaymentDate: string | null;
        lastPaymentNumber: string | null;
        lastPaymentAmount: string | null;
        paidInPeriod: string;
        collectedInPeriod: string;
      }>`
        select t.id as "traderId", t.code, t.name_en as "nameEn", t.name_ar as "nameAr",
               (t.account_status = 'active') as "isActive",
               coalesce(payable.amount, 0)::text as payable,
               coalesce(paid.amount, 0)::text as paid,
               coalesce(fees.amount, 0)::text as receivables,
               coalesce(collected.amount, 0)::text as collected,
               coalesce(fees.open, 0)::text as "openReceivables",
               coalesce(waiting.active, 0)::int as "ordersWaiting",
               coalesce(waiting.unreconciled, 0)::int as "awaitingDriverCash",
               last_payment.date as "lastPaymentDate",
               last_payment.number as "lastPaymentNumber",
               last_payment.amount as "lastPaymentAmount",
               coalesce(period_paid.amount, 0)::text as "paidInPeriod",
               coalesce(period_collected.amount, 0)::text as "collectedInPeriod"
          from traders t
          left join lateral (
            select sum(o.trader_net_payable) as amount
              from orders o
             where o.company_id = t.company_id and o.trader_id = t.id
               and o.delivery_status in ('delivered', 'closed')
               and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
               and o.delivered_at is not null
          ) payable on true
          left join lateral (
            select sum(p.amount) as amount
              from trader_settlements s
              join trader_settlement_payments p on p.settlement_id = s.id and p.company_id = s.company_id
             where s.company_id = t.company_id and s.trader_id = t.id
               and s.reversal_of_id is null and s.status = 'confirmed'
               and not exists (select 1 from trader_settlements rv
                 where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
          ) paid on true
          left join lateral (
            select sum(r.original_amount_due) as amount, sum(r.outstanding_amount) as open
              from trader_receivables r
             where r.company_id = t.company_id and r.trader_id = t.id
               and r.status not in ('cancelled', 'reversed')
               -- Owed only once its Order is delivered -- the same rule the
               -- settlement collects by (Aiman, 31 Oct 2026), so this balance
               -- is always what "Settle" can actually settle.
               and ${receivableCollectableNowSql("r")}
          ) fees on true
          left join lateral (
            select sum(alloc.amount_allocated) as amount
              from trader_collection_allocations alloc
              join trader_collections c on c.id = alloc.collection_id and c.company_id = alloc.company_id
             where c.company_id = t.company_id and c.trader_id = t.id and c.status <> 'reversed'
          ) collected on true
          left join lateral (
            select count(*) filter (where ${standardActivePredicate()}
                     and o.delivery_status <> 'returned_to_trader') as active,
                   count(*) filter (where o.delivery_status in ('delivered', 'closed')
                     and o.driver_reconciliation_status not in ('reconciled', 'not_applicable')) as unreconciled
              from orders o
             where o.company_id = t.company_id and o.trader_id = t.id
          ) waiting on true
          left join lateral (
            select s.business_date::text as date, s.settlement_number as number, p.amount::text as amount
              from trader_settlements s
              join trader_settlement_payments p on p.settlement_id = s.id and p.company_id = s.company_id
             where s.company_id = t.company_id and s.trader_id = t.id
               and s.reversal_of_id is null and s.status = 'confirmed'
               and not exists (select 1 from trader_settlements rv
                 where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
             order by s.business_date desc, s.created_at desc
             limit 1
          ) last_payment on true
          left join lateral (
            select sum(p.amount) as amount
              from trader_settlements s
              join trader_settlement_payments p on p.settlement_id = s.id and p.company_id = s.company_id
             where s.company_id = t.company_id and s.trader_id = t.id
               and s.reversal_of_id is null and s.status = 'confirmed'
               and not exists (select 1 from trader_settlements rv
                 where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
               and (${from}::date is null or s.business_date >= ${from}::date)
               and (${to}::date is null or s.business_date <= ${to}::date)
          ) period_paid on true
          left join lateral (
            select sum(c.amount_received) as amount
              from trader_collections c
             where c.company_id = t.company_id and c.trader_id = t.id and c.status <> 'reversed'
               and (${from}::date is null or c.payment_date >= ${from}::date)
               and (${to}::date is null or c.payment_date <= ${to}::date)
          ) period_collected on true
         where t.company_id = ${companyId}::uuid
           and (${traderId}::uuid is null or t.id = ${traderId}::uuid)
           and (${search}::text is null
             or t.name_en ilike '%' || ${search}::text || '%'
             or coalesce(t.name_ar, '') ilike '%' || ${search}::text || '%'
             or t.code ilike '%' || ${search}::text || '%')
         order by t.name_en, t.code
      `.execute(this.database)
    ).rows;
    const money = (value: Decimal.Value) =>
      new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    let owedToTraders = new Decimal(0);
    let owedByTraders = new Decimal(0);
    const items: TraderAccountRow[] = [];
    for (const row of rows) {
      const balance = money(row.payable).minus(row.paid).minus(row.receivables).plus(row.collected);
      const hasActivity =
        !balance.isZero() || row.ordersWaiting > 0 || row.awaitingDriverCash > 0;
      // Inactive Traders with nothing open add only noise.
      if (!row.isActive && !hasActivity) continue;
      const periodActivity =
        !new Decimal(row.paidInPeriod).isZero() || !new Decimal(row.collectedInPeriod).isZero();
      // A date range lists the Traders paid, or collected from, in it
      // ("Open balance only" then does not apply); without one, the filter
      // keeps the Traders whose balance is not zero.
      if (from !== null || to !== null) {
        if (!periodActivity) continue;
      } else if (query.openOnly === true && balance.isZero()) continue;
      if (balance.greaterThan(0)) owedToTraders = owedToTraders.plus(balance);
      else owedByTraders = owedByTraders.plus(balance.abs());
      items.push({
        awaitingDriverCash: row.awaitingDriverCash,
        balance: balance.toFixed(2),
        code: row.code,
        collectedInPeriod: money(row.collectedInPeriod).toFixed(2),
        isActive: row.isActive,
        lastPaymentAmount: row.lastPaymentAmount === null ? null : money(row.lastPaymentAmount).toFixed(2),
        lastPaymentDate: row.lastPaymentDate,
        lastPaymentNumber: row.lastPaymentNumber,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        openReceivables: money(row.openReceivables).toFixed(2),
        ordersWaiting: row.ordersWaiting,
        paidInPeriod: money(row.paidInPeriod).toFixed(2),
        traderId: row.traderId,
      });
    }
    return {
      items,
      totals: { owedByTraders: owedByTraders.toFixed(2), owedToTraders: owedToTraders.toFixed(2) },
    };
  }

  /**
   * Reference lookup (Aiman, 31 Oct 2026: "reference very important"): for
   * each reference typed or pasted, its Order, Trader, delivery and where the
   * Trader's money went -- the Settlement (SET) that paid it, the 0.00
   * invoice (INV), or the fee (RCV) and the collection (COL) that took it.
   * Company-scoped; references are unique per Company.
   */
  public async lookup(referencesText: string): Promise<readonly TraderReferenceLookupRow[]> {
    this.assertPermission();
    const { companyId } = this.tenants.current();
    const requested = [
      ...new Set(
        referencesText
          .split(/[\s,;]+/u)
          .map((value) => value.normalize("NFKC").trim())
          .filter((value) => value !== ""),
      ),
    ];
    if (requested.length === 0) return [];
    if (requested.length > 500) {
      throw new ApplicationException(
        "too_many_reference_numbers",
        "Enter at most 500 reference numbers",
        HttpStatus.BAD_REQUEST,
      );
    }
    const keys = requested.map((value) => value.toLocaleLowerCase("en-US"));
    const rows = (
      await sql<{
        position: number;
        orderNumber: string | null;
        referenceNumber: string | null;
        traderId: string | null;
        traderCode: string | null;
        traderNameEn: string | null;
        traderNameAr: string | null;
        orderDate: string | null;
        deliveryDate: string | null;
        deliveryStatus: string | null;
        traderAmount: string | null;
        traderOutstanding: string | null;
        settledIn: string[] | null;
        feeNumbers: string[] | null;
      }>`
        select input.position::int as position,
               o.order_number as "orderNumber", o.reference_number as "referenceNumber",
               t.id as "traderId", t.code as "traderCode", t.name_en as "traderNameEn", t.name_ar as "traderNameAr",
               o.order_date::text as "orderDate",
               (o.delivered_at at time zone 'Asia/Dubai')::date::text as "deliveryDate",
               o.delivery_status as "deliveryStatus",
               o.trader_net_payable::text as "traderAmount",
               o.trader_outstanding_balance::text as "traderOutstanding",
               array(
                 select s.settlement_number || ' (' || s.business_date::text || ')'
                   from trader_settlement_orders link
                   join trader_settlements s on s.id = link.settlement_id and s.company_id = link.company_id
                  where link.company_id = o.company_id and link.order_id = o.id
                    and ${settlementLineActiveSql("link")}
                    and s.reversal_of_id is null and s.status = 'confirmed'
                    and not exists (select 1 from trader_settlements rv
                      where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
                 union all
                 select coalesce(zi.invoice_number, zs.settlement_number) || ' (0.00, '
                        || coalesce((zi.created_at at time zone 'Asia/Dubai')::date, zs.business_date)::text || ')'
                   from trader_settlement_zero_due_orders z
                   left join trader_zero_invoices zi on zi.id = z.zero_invoice_id and zi.company_id = z.company_id
                   left join trader_settlements zs on zs.id = z.settlement_id and zs.company_id = z.company_id
                  where z.company_id = o.company_id and z.order_id = o.id
                    and ${zeroDueLineActiveSql("z")}
                    and (zi.id is null or zi.reversed_at is null)
                    and (zs.id is null or not exists (select 1 from trader_settlements zrv
                      where zrv.company_id = zs.company_id and zrv.reversal_of_id = zs.id))
                 union all
                 select c.collection_number || ' (' || c.payment_date::text || ')'
                   from trader_receivables r
                   join trader_collection_allocations alloc on alloc.receivable_id = r.id and alloc.company_id = r.company_id
                   join trader_collections c on c.id = alloc.collection_id and c.company_id = alloc.company_id
                  where r.company_id = o.company_id and r.source_type = 'service_charge'
                    and r.source_reference = o.order_number and c.status <> 'reversed'
               ) as "settledIn",
               array(
                 select r.receivable_number || ' ' || r.original_amount_due::text || ' (' || r.status || ')'
                   from trader_receivables r
                  where r.company_id = o.company_id and r.source_type = 'service_charge'
                    and r.source_reference = o.order_number
                    and r.status not in ('cancelled', 'reversed')
                  order by r.receivable_number
               ) as "feeNumbers"
          from unnest(${keys}::text[]) with ordinality as input(key, position)
          left join orders o on o.company_id = ${companyId}::uuid and o.reference_number_normalized = input.key
          left join traders t on t.id = o.trader_id and t.company_id = o.company_id
         order by input.position, o.order_number
      `.execute(this.database)
    ).rows;
    return rows.map((row) => ({
      deliveryDate: row.deliveryDate,
      deliveryStatus: row.deliveryStatus,
      feeNumbers: row.feeNumbers ?? [],
      found: row.orderNumber !== null,
      orderDate: row.orderDate,
      orderNumber: row.orderNumber,
      referenceNumber: row.referenceNumber,
      requested: requested[row.position - 1] ?? "",
      settledIn: row.settledIn ?? [],
      traderAmount: row.traderAmount,
      traderCode: row.traderCode,
      traderId: row.traderId,
      traderNameAr: row.traderNameAr,
      traderNameEn: row.traderNameEn,
      traderOutstanding: row.traderOutstanding,
    }));
  }

  /**
   * Every document the Trader has: Settlements (SET), 0.00 invoices (INV) and
   * collections from the Trader (COL), newest first, reversed ones included
   * and marked.
   */
  public async documents(traderId: string): Promise<readonly TraderAccountDocument[]> {
    this.assertPermission();
    const { companyId } = this.tenants.current();
    const trader = (
      await sql<{ id: string }>`
        select id from traders where id = ${traderId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (trader === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
    const rows = (
      await sql<{
        kind: TraderDocumentKind;
        id: string;
        number: string;
        date: string;
        amount: string;
        orderCount: number;
        reversed: boolean;
        draftId: string | null;
        createdAt: string;
      }>`
        select 'settlement'::text as kind, s.id, s.settlement_number as number,
               s.business_date::text as date,
               coalesce((select sum(p.amount) from trader_settlement_payments p
                  where p.company_id = s.company_id and p.settlement_id = s.id), 0)::text as amount,
               (select count(*) from trader_settlement_orders link
                  where link.company_id = s.company_id and link.settlement_id = s.id
                    and ${settlementLineActiveSql("link")})::int as "orderCount",
               exists (select 1 from trader_settlements rv
                  where rv.company_id = s.company_id and rv.reversal_of_id = s.id) as reversed,
               (select d.id from trader_settlement_drafts d
                  where d.company_id = s.company_id and d.confirmed_settlement_id = s.id
                  order by d.confirmed_at desc nulls last limit 1) as "draftId",
               s.created_at::text as "createdAt"
          from trader_settlements s
         where s.company_id = ${companyId}::uuid and s.trader_id = ${traderId}::uuid
           and s.reversal_of_id is null and s.status = 'confirmed'
        union all
        select 'zero_invoice'::text, zi.id, zi.invoice_number,
               (zi.created_at at time zone 'Asia/Dubai')::date::text, '0.00',
               (select count(*) from trader_settlement_zero_due_orders z
                  where z.company_id = zi.company_id and z.zero_invoice_id = zi.id
                    and ${zeroDueLineActiveSql("z")})::int,
               zi.reversed_at is not null,
               (select d.id from trader_settlement_drafts d
                  where d.company_id = zi.company_id and d.confirmed_zero_invoice_id = zi.id
                  order by d.confirmed_at desc nulls last limit 1),
               zi.created_at::text
          from trader_zero_invoices zi
         where zi.company_id = ${companyId}::uuid and zi.trader_id = ${traderId}::uuid
        union all
        select 'collection'::text, c.id, c.collection_number, c.payment_date::text,
               c.amount_received::text,
               (select count(distinct r.source_reference) from trader_collection_allocations alloc
                  join trader_receivables r on r.id = alloc.receivable_id and r.company_id = alloc.company_id
                 where alloc.company_id = c.company_id and alloc.collection_id = c.id)::int,
               c.status = 'reversed',
               (select d.id from trader_settlement_drafts d
                  where d.company_id = c.company_id and d.confirmed_collection_id = c.id
                  order by d.confirmed_at desc nulls last limit 1),
               c.created_at::text
          from trader_collections c
         where c.company_id = ${companyId}::uuid and c.trader_id = ${traderId}::uuid
        order by date desc, "createdAt" desc
      `.execute(this.database)
    ).rows;
    return rows.map(({ createdAt: _createdAt, ...row }) => ({
      ...row,
      amount: new Decimal(row.amount).toFixed(2),
    }));
  }

  private assertPermission(): void {
    const permissions = this.identities.current().permissions;
    if (
      !["users_roles.manage", "settlements.create", "reports.export", "trader_receivables.create"].some(
        (key) => permissions.has(key),
      )
    ) {
      throw new ApplicationException("permission_denied", "Permission denied", HttpStatus.FORBIDDEN);
    }
  }
}
