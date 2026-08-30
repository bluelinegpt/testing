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
  readonly codAmount: string;
  readonly createdAt: string;
  readonly date: string;
  readonly description: string;
  readonly id: string;
  readonly isOutstanding: boolean;
  readonly notes: string | null;
  readonly orderNumber: string | null;
  readonly paymentReference: string | null;
  readonly reference: string;
  readonly reversalAmount: string;
  readonly sequence: number;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
  readonly settlementAmount: string;
  readonly sourceStatus: string;
  readonly traderPayable: string;
  readonly type: "order" | "payment" | "reversal";
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
  readonly paymentReference: string | null;
  readonly reference: string;
  readonly settlementNumber: string | null;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
  readonly settlementAmount: string;
  readonly reversalAmount: string;
  readonly status: string;
  readonly runningBalance: string;
  readonly type: "order" | "payment" | "reversal";
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
               o.order_number as "orderNumber", coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "paymentReference", o.cod_amount::text as "codAmount",
               o.service_fee::text as "serviceFee", coalesce(o.additional_fees, 0)::text as "additionalFee",
               o.trader_net_payable::text as "traderPayable", '0.00'::text as "settlementAmount",
               '0.00'::text as "reversalAmount", o.delivery_status as "sourceStatus",
               o.notes
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
               null::text, null::text, p.bank_reference, '0.00'::text, '0.00'::text,
               '0.00'::text, '0.00'::text, p.amount::text, '0.00'::text,
               s.status, null::text
          from trader_settlements s
          join trader_settlement_payments p
            on p.settlement_id = s.id and p.company_id = s.company_id
         where s.company_id = ${companyId}::uuid and s.trader_id = ${traderId}::uuid
           and s.reversal_of_id is null and s.status = 'confirmed'
           and s.business_date between ${from}::date and ${to}::date
        union all
        select r.id, 'reversal'::text, r.business_date::text, r.created_at::text, 3,
               r.settlement_number, ('Reversal of ' || original.settlement_number),
               coalesce(p.amount, 0)::text, false,
               null::text, null::text, p.bank_reference, '0.00'::text, '0.00'::text,
               '0.00'::text, '0.00'::text, '0.00'::text, coalesce(p.amount, 0)::text,
               'reversed'::text, null::text
          from trader_settlements r
          join trader_settlements original
            on original.id = r.reversal_of_id and original.company_id = r.company_id
          left join trader_settlement_payments p
            on p.settlement_id = original.id and p.company_id = original.company_id
         where r.company_id = ${companyId}::uuid and r.trader_id = ${traderId}::uuid
           and r.business_date between ${from}::date and ${to}::date
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
         group by s.id, p.id
         order by s.business_date, s.created_at, s.id
      `.execute(this.database)
    ).rows;
    const settlements: TraderAccountStatementSettlement[] = [];
    for (const settlement of settlementRows) {
      const allocations = (
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
      if (row.type === "order") {
        running = running.plus(amount);
        payable = payable.plus(amount);
      } else if (row.type === "payment") {
        running = running.minus(amount);
        payments = payments.plus(amount);
      } else {
        running = running.plus(amount);
        reversals = reversals.plus(amount);
      }
      return {
        additionalFee: row.additionalFee,
        codAmount: row.codAmount,
        credit: row.type === "payment" ? amount.toFixed(2) : "0.00",
        date: row.date,
        debit: row.type === "payment" ? "0.00" : amount.toFixed(2),
        description: row.description,
        id: row.id,
        isOutstanding: row.isOutstanding,
        lineNumber: index + 1,
        notes: row.notes,
        orderNumber: row.orderNumber,
        paymentReference: row.paymentReference,
        reference: row.reference,
        runningBalance: this.money(running).toFixed(2),
        settlementNumber: row.type === "order" ? null : row.reference,
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
      if (query.reversedOnly === true && row.type !== "reversal") return false;
      if (query.paidOnly === true && !["payment", "reversal"].includes(row.type)) return false;
      if (query.outstandingOnly === true && (row.type !== "order" || !row.isOutstanding))
        return false;
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
        row.type === query.transactionType
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
              and not exists (select 1 from trader_settlements r
                where r.company_id = s.company_id and r.reversal_of_id = s.id
                  and r.business_date < ${from}::date)), 0)
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
