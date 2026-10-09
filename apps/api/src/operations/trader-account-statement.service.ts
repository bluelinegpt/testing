import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import type { TraderAccountStatementQueryDto } from "./operations.dto.js";
import {
  buildTraderAccountStatementHtml,
  type TraderAccountStatementLanguage,
} from "./trader-account-statement-html.js";

interface StatementSourceRow {
  readonly additionalFee: string;
  readonly amount: string;
  /** Positive increases the amount owed to the Trader; negative reduces it. */
  readonly balanceImpact: string;
  readonly codAmount: string;
  readonly createdAt: string;
  readonly date: string;
  readonly description: string;
  readonly id: string;
  readonly isOutstanding: boolean;
  readonly notes: string | null;
  readonly orderNumber: string | null;
  readonly referenceNumber: string | null;
  readonly paymentReference: string | null;
  readonly reference: string;
  readonly settlementNumber: string | null;
  readonly reversalAmount: string;
  readonly sequence: number;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
  readonly settlementAmount: string;
  readonly sourceStatus: string;
  readonly traderPayable: string;
  readonly type:
    | "order"
    | "payment"
    | "reversal"
    | "receivable"
    | "collection"
    | "collection_reversal"
    | "receivable_cancellation";
}

export interface TraderAccountStatementLine {
  readonly additionalFee: string;
  readonly codAmount: string;
  readonly credit: string;
  readonly date: string;
  readonly debit: string;
  readonly description: string;
  readonly id: string;
  readonly isOutstanding: boolean;
  readonly lineNumber: number;
  readonly notes: string | null;
  readonly orderNumber: string | null;
  readonly referenceNumber: string | null;
  readonly paymentReference: string | null;
  readonly reference: string;
  readonly settlementNumber: string | null;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
  readonly settlementAmount: string;
  readonly reversalAmount: string;
  readonly status: string;
  readonly runningBalance: string;
  readonly type:
    | "order"
    | "payment"
    | "reversal"
    | "receivable"
    | "collection"
    | "collection_reversal"
    | "receivable_cancellation";
  readonly traderPayable: string;
}

export interface TraderAccountStatementSettlement {
  readonly amount: string;
  readonly allocations: readonly {
    readonly allocatedAmount: string;
    readonly deliveryDate: string | null;
    readonly orderNumber: string;
    readonly originalTraderPayable: string;
    readonly previouslySettled: string;
    readonly remainingAfterSettlement: string;
    readonly serialNumber: string;
    readonly status: string;
  }[];
  readonly date: string;
  readonly isReversed: boolean;
  readonly linkedOrderCount: number;
  readonly paymentMethod: string;
  readonly paymentReference: string | null;
  readonly settlementNumber: string;
  readonly status: string;
}

export interface TraderAccountStatement {
  readonly company: {
    readonly logoDataUri: string | null;
    readonly nameAr: string | null;
    readonly nameEn: string;
  };
  readonly generatedAt: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly summary: {
    readonly closingBalance: string;
    readonly netPayments: string;
    readonly openingBalance: string;
    readonly totalPayments: string;
    readonly totalPayable: string;
    readonly totalReversals: string;
    readonly codCollected: string;
    readonly serviceFeesDeducted: string;
    readonly additionalFees: string;
    readonly deliveredOrderCount: number;
    readonly settledOrderCount: number;
    readonly partiallySettledOrderCount: number;
    readonly outstandingOrderCount: number;
    readonly outstandingAmount: string;
  };
  readonly settlements: readonly TraderAccountStatementSettlement[];
  readonly trader: {
    readonly id: string;
    readonly nameAr: string | null;
    readonly nameEn: string;
    readonly number: string;
  };
  readonly transactions: readonly TraderAccountStatementLine[];
  readonly warnings: readonly string[];
}

@Injectable()
export class TraderAccountStatementService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async statement(
    traderId: string,
    query: TraderAccountStatementQueryDto,
  ): Promise<TraderAccountStatement> {
    this.assertPermission(["settlements.create", "reports.export"]);
    const { companyId } = this.tenants.current();
    const { from, to } = this.range(query);
    const trader = (
      await sql<{ id: string; nameAr: string | null; nameEn: string; number: string }>`
        select id, name_ar as "nameAr", name_en as "nameEn",
               code as number
          from traders where id = ${traderId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (trader === undefined) {
      throw new ApplicationException("trader_not_found", "Trader not found", HttpStatus.NOT_FOUND);
    }
    const opening = await this.balanceBefore(companyId, traderId, from);
    const source = (
      await sql<StatementSourceRow>`
        select o.id, 'order'::text as type,
               (o.delivered_at at time zone 'Asia/Dubai')::date::text as date,
               o.created_at::text as "createdAt", 1 as sequence,
               coalesce(o.serial_number, o.order_number) as reference,
               ('Delivered Order · ' || coalesce(o.customer_name, '')) as description,
               o.trader_net_payable::text as amount,
               (o.trader_outstanding_balance > 0) as "isOutstanding",
               o.order_number as "orderNumber", o.reference_number as "referenceNumber",
               coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "paymentReference", o.cod_amount::text as "codAmount",
               o.service_fee::text as "serviceFee", coalesce(o.additional_fees, 0)::text as "additionalFee",
               o.trader_net_payable::text as "traderPayable", '0.00'::text as "settlementAmount",
               '0.00'::text as "reversalAmount", o.delivery_status as "sourceStatus",
               o.notes, o.trader_net_payable::text as "balanceImpact",
               null::text as "settlementNumber"
          from orders o
         where o.company_id = ${companyId}::uuid and o.trader_id = ${traderId}::uuid
           -- 'closed' is the terminal state a delivered Order reaches once its
           -- Driver cash is reconciled and its Trader Settlement is complete
           -- (see changeOrderStatus's delivered -> closed transition). It
           -- must stay visible here or a fully-settled Order silently drops
           -- out of this statement's payable/opening-balance math while the
           -- Settlement payment that paid it is still counted independently
           -- -- producing a phantom negative Closing Balance for a Trader who
           -- in fact owes nothing.
           and o.delivery_status in ('delivered', 'closed')
           -- A delivered parcel is still provisional until its Driver cash is
           -- reconciled. Do not present that provisional amount as money owed
           -- by the Company; it may still enter a return workflow.
           and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
           and (o.delivered_at at time zone 'Asia/Dubai')::date between ${from}::date and ${to}::date
        union all
        select s.id, 'payment'::text, s.business_date::text, s.created_at::text, 2,
               s.settlement_number, 'Trader payment', p.amount::text, false,
               null::text, null::text, null::text, p.bank_reference, '0.00'::text, '0.00'::text,
               '0.00'::text, '0.00'::text, p.amount::text, '0.00'::text,
               s.status, null::text, (-p.amount)::text,
               s.settlement_number as "settlementNumber"
          from trader_settlements s
          join trader_settlement_payments p
            on p.settlement_id = s.id and p.company_id = s.company_id
         where s.company_id = ${companyId}::uuid and s.trader_id = ${traderId}::uuid
           and s.reversal_of_id is null and s.status = 'confirmed'
           -- The Trader sees only transactions that stand (decision 9 Oct
           -- 2026): a reversed Settlement and its reversal are both left out.
           and not exists (select 1 from trader_settlements rv
                where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
           and s.business_date between ${from}::date and ${to}::date
        union all
        select r.id, 'receivable'::text, r.business_date::text, r.created_at::text, 2,
               r.receivable_number,
               (case when r.source_type = 'service_charge' then 'Service fee receivable'
                     else 'Trader receivable · ' || r.reason end
                || case when linked.id is null then '' else ' · Order '
                     || coalesce(linked.serial_number, linked.order_number) || ' (' || linked.order_number || ')' end),
               r.original_amount_due::text, (r.outstanding_amount > 0),
               linked.order_number, null::text, coalesce(linked.serial_number, linked.order_number),
               null::text, '0.00'::text, '0.00'::text, '0.00'::text, '0.00'::text,
               '0.00'::text, '0.00'::text, r.status, r.notes, (-r.original_amount_due)::text,
               null::text as "settlementNumber"
          from trader_receivables r
          left join orders linked on linked.company_id = r.company_id
            and r.source_type = 'service_charge' and linked.order_number = r.source_reference
         where r.company_id = ${companyId}::uuid and r.trader_id = ${traderId}::uuid
           -- A cancelled or reversed charge (e.g. replaced after a fee change)
           -- is left out together with its cancellation.
           and r.status not in ('cancelled', 'reversed')
           and r.business_date between ${from}::date and ${to}::date
        union all
        select alloc.id, 'collection'::text, c.payment_date::text, c.created_at::text, 3,
               c.collection_number,
               'Trader collection received · ' || r.receivable_number
                 || case when linked.id is null then '' else ' · Order '
                     || coalesce(linked.serial_number, linked.order_number) || ' (' || linked.order_number || ')' end,
               alloc.amount_allocated::text, false,
               linked.order_number, null::text, coalesce(linked.serial_number, linked.order_number),
               c.payment_reference, '0.00'::text, '0.00'::text, '0.00'::text, '0.00'::text,
               '0.00'::text, '0.00'::text, c.status, c.notes, alloc.amount_allocated::text,
               c.collection_number as "settlementNumber"
          from trader_collection_allocations alloc
          join trader_collections c on c.id = alloc.collection_id and c.company_id = alloc.company_id
          join trader_receivables r on r.id = alloc.receivable_id and r.company_id = alloc.company_id
          left join orders linked on linked.company_id = r.company_id
            and r.source_type = 'service_charge' and linked.order_number = r.source_reference
         where c.company_id = ${companyId}::uuid and c.trader_id = ${traderId}::uuid
           and c.status <> 'reversed'
           and c.payment_date between ${from}::date and ${to}::date
        order by date, "createdAt", sequence, id
      `.execute(this.database)
    ).rows;
    const periodSummary = (
      await sql<{
        additionalFees: string;
        codCollected: string;
        deliveredOrderCount: number;
        outstandingAmount: string;
        outstandingOrderCount: number;
        partiallySettledOrderCount: number;
        serviceFees: string;
        settledOrderCount: number;
      }>`
        select coalesce(sum(o.cod_amount), 0)::text as "codCollected",
               coalesce(sum(o.service_fee), 0)::text as "serviceFees",
               coalesce(sum(o.additional_fees), 0)::text as "additionalFees",
               count(*)::int as "deliveredOrderCount",
               count(*) filter (where o.trader_outstanding_balance = 0)::int as "settledOrderCount",
               count(*) filter (where o.trader_paid_amount > 0 and o.trader_outstanding_balance > 0)::int as "partiallySettledOrderCount",
               count(*) filter (where o.trader_outstanding_balance > 0)::int as "outstandingOrderCount",
               coalesce(sum(o.trader_outstanding_balance), 0)::text as "outstandingAmount"
          from orders o
         where o.company_id = ${companyId}::uuid and o.trader_id = ${traderId}::uuid
           -- Same reason as the source query above: 'closed' is a delivered
           -- Order's own terminal state, not a different lifecycle.
           and o.delivery_status in ('delivered', 'closed')
           and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
           and (o.delivered_at at time zone 'Asia/Dubai')::date between ${from}::date and ${to}::date
      `.execute(this.database)
    ).rows[0];
    const settlementRows = (
      await sql<{
        amount: string;
        date: string;
        isReversed: boolean;
        linkedOrderCount: number;
        paymentMethod: string;
        paymentReference: string | null;
        settlementId: string;
        settlementNumber: string;
        status: string;
      }>`
        select s.id as "settlementId", s.settlement_number as "settlementNumber",
               s.business_date::text as date, p.amount::text as amount,
               p.payment_method as "paymentMethod", p.bank_reference as "paymentReference",
               s.status, exists(select 1 from trader_settlements r
                 where r.company_id = s.company_id and r.reversal_of_id = s.id) as "isReversed",
               count(link.id)::int as "linkedOrderCount"
          from trader_settlements s
          join trader_settlement_payments p on p.settlement_id = s.id and p.company_id = s.company_id
          left join trader_settlement_orders link on link.settlement_id = s.id and link.company_id = s.company_id
         where s.company_id = ${companyId}::uuid and s.trader_id = ${traderId}::uuid
           and s.reversal_of_id is null and s.business_date between ${from}::date and ${to}::date
           and not exists (select 1 from trader_settlements rv
                where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
         group by s.id, p.id
         order by s.business_date, s.created_at, s.id
      `.execute(this.database)
    ).rows;
    const settlements: TraderAccountStatementSettlement[] = [];
    for (const settlement of settlementRows) {
      const allocationRows = (
        await sql<TraderAccountStatementSettlement["allocations"][number]>`
          select o.order_number as "orderNumber",
                 coalesce(o.serial_number, o.order_number) as "serialNumber",
                 (o.delivered_at at time zone 'Asia/Dubai')::date::text as "deliveryDate",
                 link.net_payable::text as "originalTraderPayable",
                 coalesce((
                   select sum(previous.allocated_amount)
                     from trader_settlement_orders previous
                     join trader_settlements previous_settlement
                       on previous_settlement.id = previous.settlement_id
                      and previous_settlement.company_id = previous.company_id
                    where previous.company_id = link.company_id
                      and previous.order_id = link.order_id
                      and previous.settlement_id <> link.settlement_id
                      and (previous_settlement.business_date, previous_settlement.created_at, previous_settlement.id)
                          < (s.business_date, s.created_at, s.id)
                      and not exists (
                        select 1 from trader_settlements prior_reversal
                         where prior_reversal.company_id = previous_settlement.company_id
                           and prior_reversal.reversal_of_id = previous_settlement.id
                           and prior_reversal.business_date <= s.business_date
                      )
                 ), 0)::text as "previouslySettled",
                 link.allocated_amount::text as "allocatedAmount",
                 greatest(link.net_payable - coalesce((
                   select sum(previous.allocated_amount)
                     from trader_settlement_orders previous
                     join trader_settlements previous_settlement
                       on previous_settlement.id = previous.settlement_id
                      and previous_settlement.company_id = previous.company_id
                    where previous.company_id = link.company_id
                      and previous.order_id = link.order_id
                      and previous.settlement_id <> link.settlement_id
                      and (previous_settlement.business_date, previous_settlement.created_at, previous_settlement.id)
                          < (s.business_date, s.created_at, s.id)
                      and not exists (
                        select 1 from trader_settlements prior_reversal
                         where prior_reversal.company_id = previous_settlement.company_id
                           and prior_reversal.reversal_of_id = previous_settlement.id
                           and prior_reversal.business_date <= s.business_date
                      )
                 ), 0) - link.allocated_amount, 0)::text as "remainingAfterSettlement",
                 o.trader_settlement_status as status
            from trader_settlement_orders link
            join trader_settlements s
              on s.id = link.settlement_id and s.company_id = link.company_id
            join orders o on o.id = link.order_id and o.company_id = link.company_id
           where link.company_id = ${companyId}::uuid
             and link.settlement_id = ${settlement.settlementId}::uuid
           order by o.delivered_at, o.created_at, o.id
        `.execute(this.database)
      ).rows;
      const allocations = settlement.isReversed
        ? allocationRows.map((allocation) => ({
            ...allocation,
            allocatedAmount: "0.00",
            remainingAfterSettlement: Decimal.max(
              0,
              new Decimal(allocation.originalTraderPayable).minus(allocation.previouslySettled),
            ).toFixed(2),
          }))
        : allocationRows;
      settlements.push({ ...settlement, allocations });
    }
    const reversedSettlementNumbers = new Set(
      settlements
        .filter((settlement) => settlement.isReversed)
        .map((settlement) => settlement.settlementNumber),
    );
    let running = new Decimal(opening);
    let payable = new Decimal(0);
    let payments = new Decimal(0);
    let reversals = new Decimal(0);
    const allTransactions = source.map((row, index): TraderAccountStatementLine => {
      const amount = this.money(row.amount);
      const balanceImpact = this.money(row.balanceImpact);
      running = running.plus(balanceImpact);
      if (row.type === "order") {
        payable = payable.plus(amount);
      } else if (row.type === "payment") {
        payments = payments.plus(amount);
      } else if (row.type === "reversal") {
        reversals = reversals.plus(amount);
      }
      return {
        additionalFee: row.additionalFee,
        codAmount: row.codAmount,
        credit: balanceImpact.lessThan(0) ? balanceImpact.abs().toFixed(2) : "0.00",
        date: row.date,
        debit: balanceImpact.greaterThan(0) ? balanceImpact.toFixed(2) : "0.00",
        description: row.description,
        id: row.id,
        isOutstanding: row.isOutstanding,
        lineNumber: index + 1,
        notes: row.notes,
        orderNumber: row.orderNumber,
        referenceNumber: row.referenceNumber,
        paymentReference: row.paymentReference,
        reference: row.reference,
        runningBalance: this.money(running).toFixed(2),
        settlementNumber: row.settlementNumber,
        serialNumber: row.serialNumber,
        serviceFee: row.serviceFee,
        settlementAmount: row.settlementAmount,
        reversalAmount: row.reversalAmount,
        status: row.sourceStatus,
        traderPayable: row.traderPayable,
        type: row.type,
      };
    });
    const transactions = allTransactions.filter((row) => {
      if (query.reversedOnly === true && !["reversal", "collection_reversal"].includes(row.type))
        return false;
      if (
        query.paidOnly === true &&
        !["payment", "reversal", "collection", "collection_reversal"].includes(row.type)
      )
        return false;
      if (query.outstandingOnly === true && !["order", "receivable"].includes(row.type))
        return false;
      if (query.outstandingOnly === true && !row.isOutstanding) return false;
      if (
        query.settlementStatus === "reversed" &&
        row.type !== "reversal" &&
        !(row.type === "payment" && reversedSettlementNumbers.has(row.reference))
      )
        return false;
      if (
        query.settlementStatus === "confirmed" &&
        (row.type === "reversal" ||
          (row.type === "payment" && reversedSettlementNumbers.has(row.reference)))
      )
        return false;
      return (
        query.transactionType === undefined ||
        query.transactionType === "all" ||
        (query.transactionType === "order" &&
          ["order", "receivable", "receivable_cancellation"].includes(row.type)) ||
        (query.transactionType === "payment" && ["payment", "collection"].includes(row.type)) ||
        (query.transactionType === "reversal" &&
          ["reversal", "collection_reversal"].includes(row.type))
      );
    });
    const branding = await this.companyProfile.branding();
    const logoDataUri = branding.hasLogo
      ? await this.companyProfile
          .logoContent()
          .then((logo) => `data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`)
          .catch(() => null)
      : null;
    const dayAfterTo = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const outstandingAtEnd = await this.balanceBefore(companyId, traderId, dayAfterTo);
    const warnings = this.money(outstandingAtEnd).equals(this.money(running))
      ? []
      : [
          `Data-integrity warning: event closing balance ${this.money(running).toFixed(2)} does not match the as-of outstanding balance ${this.money(outstandingAtEnd).toFixed(2)}.`,
        ];
    return {
      company: { logoDataUri, nameAr: branding.nameAr, nameEn: branding.nameEn },
      generatedAt: new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Dubai",
      }).format(new Date()),
      period: { from, to },
      summary: {
        additionalFees: this.money(periodSummary?.additionalFees ?? 0).toFixed(2),
        codCollected: this.money(periodSummary?.codCollected ?? 0).toFixed(2),
        closingBalance: this.money(running).toFixed(2),
        deliveredOrderCount: periodSummary?.deliveredOrderCount ?? 0,
        netPayments: this.money(payments.minus(reversals)).toFixed(2),
        openingBalance: this.money(opening).toFixed(2),
        outstandingAmount: this.money(outstandingAtEnd).toFixed(2),
        outstandingOrderCount: periodSummary?.outstandingOrderCount ?? 0,
        partiallySettledOrderCount: periodSummary?.partiallySettledOrderCount ?? 0,
        serviceFeesDeducted: this.money(periodSummary?.serviceFees ?? 0).toFixed(2),
        settledOrderCount: periodSummary?.settledOrderCount ?? 0,
        totalPayments: this.money(payments).toFixed(2),
        totalPayable: this.money(payable).toFixed(2),
        totalReversals: this.money(reversals).toFixed(2),
      },
      settlements: settlements.filter((settlement) => {
        if (query.reversedOnly === true) return settlement.isReversed;
        if (query.settlementStatus === "reversed") return settlement.isReversed;
        if (query.settlementStatus === "confirmed") return !settlement.isReversed;
        return true;
      }),
      trader,
      transactions,
      warnings,
    };
  }

  public async statementPdf(
    traderId: string,
    query: TraderAccountStatementQueryDto,
    correlationId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    this.assertPermission(["settlements.create", "reports.export"]);
    const data = await this.statement(traderId, query);
    const language: TraderAccountStatementLanguage = query.language === "ar" ? "ar" : "en";
    const bytes = await this.pdf.renderPdf(
      buildTraderAccountStatementHtml(data, language),
      language === "ar"
        ? '<div style="font-size:9px;width:100%;text-align:center;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>'
        : '<div style="font-size:9px;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    );
    const identity = this.identities.current();
    const { companyId } = this.tenants.current();
    await this.history.audit(this.database, {
      action: "trader_account_statement.pdf_generated",
      actorId: identity.identityId,
      after: { language, period: data.period, traderId },
      companyId,
      correlationId,
      subjectId: traderId,
      subjectType: "trader",
    });
    return {
      bytes,
      filename: `Trader-Statement-${data.trader.number.replaceAll(/[^A-Za-z0-9-]/g, "")}-${data.period.from}-${data.period.to}.pdf`,
    };
  }

  private async balanceBefore(companyId: string, traderId: string, from: string): Promise<Decimal> {
    const row = (
      await sql<{ opening: string }>`
        select (
          coalesce((select sum(o.trader_net_payable) from orders o
            where o.company_id = ${companyId}::uuid and o.trader_id = ${traderId}::uuid
              -- Same reason as statement()'s own source query: a Closed
              -- Order still owes/owed its Trader payable history.
              and o.delivery_status in ('delivered', 'closed')
              and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
              and (o.delivered_at at time zone 'Asia/Dubai')::date < ${from}::date), 0)
          - coalesce((select sum(p.amount) from trader_settlements s
              join trader_settlement_payments p on p.settlement_id = s.id and p.company_id = s.company_id
            where s.company_id = ${companyId}::uuid and s.trader_id = ${traderId}::uuid
              and s.reversal_of_id is null and s.status = 'confirmed' and s.business_date < ${from}::date
              -- Same rule as the lines: a reversed Settlement never counts,
              -- whenever it was reversed.
              and not exists (select 1 from trader_settlements r
                where r.company_id = s.company_id and r.reversal_of_id = s.id)), 0)
          - coalesce((select sum(r.original_amount_due) from trader_receivables r
            where r.company_id = ${companyId}::uuid and r.trader_id = ${traderId}::uuid
              and r.status not in ('cancelled', 'reversed')
              and r.business_date < ${from}::date), 0)
          + coalesce((select sum(alloc.amount_allocated)
            from trader_collection_allocations alloc
            join trader_collections c on c.id = alloc.collection_id and c.company_id = alloc.company_id
            where c.company_id = ${companyId}::uuid and c.trader_id = ${traderId}::uuid
              and c.status <> 'reversed'
              and c.payment_date < ${from}::date), 0)
        )::text as opening
      `.execute(this.database)
    ).rows[0];
    return this.money(row?.opening ?? "0");
  }

  private range(query: TraderAccountStatementQueryDto): { from: string; to: string } {
    let from = query.from;
    let to = query.to;
    if (query.month !== undefined) {
      const [year, month] = query.month.split("-").map(Number);
      from = `${query.month}-01`;
      to = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).toISOString().slice(0, 10);
    }
    if (from === undefined || to === undefined || from > to) {
      throw new ApplicationException(
        "trader_statement_period_invalid",
        "Select a valid statement month or date range",
        HttpStatus.BAD_REQUEST,
      );
    }
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (!Number.isFinite(days) || days > 366) {
      throw new ApplicationException(
        "trader_statement_period_too_large",
        "The statement date range cannot exceed 366 days",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { from, to };
  }

  private money(value: Decimal.Value): Decimal {
    return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  private assertPermission(permission: string | readonly string[]): void {
    const permissions = this.identities.current().permissions;
    const required = Array.isArray(permission) ? permission : [permission];
    if (!permissions.has("users_roles.manage") && !required.some((key) => permissions.has(key))) {
      throw new ApplicationException(
        "permission_denied",
        "Permission denied",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
