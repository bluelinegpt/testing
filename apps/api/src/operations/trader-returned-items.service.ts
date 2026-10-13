import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { accountingXlsx } from "../accounting/accounting-xlsx.js";
import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { deliveryStatusFilterPredicate } from "./delivery-status-filter.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import type { ReportLanguage } from "./driver-collection-report-html.js";
import type { GenerateShipmentManifestDto } from "./operations.dto.js";
import {
  buildTraderReturnedItemsHtml,
  returnedItemsColumns,
  returnedItemsKindLabel,
  returnedItemsTitle,
  type ReturnedItemsData,
  type ReturnedItemsOrder,
} from "./trader-returned-items-html.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The selection grouped by Trader, for the dialog's one-row-per-Trader list. */
export interface ReturnedItemsTraders {
  readonly traders: readonly {
    readonly orderCount: number;
    readonly totalPackages: number;
    readonly totalValue: string;
    readonly traderId: string;
    readonly traderName: string;
  }[];
}

interface ReturnedOrderRow {
  readonly areaName: string;
  readonly codAmount: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly deliveryStatus: string;
  readonly orderNumber: string;
  readonly packageCount: number;
  readonly reason: string | null;
  readonly referenceNumber: string | null;
  readonly returnStatus: string | null;
  readonly serialNumber: string | null;
  readonly traderId: string;
}

/**
 * An Order belongs on the Returned Items report when its goods go back to the
 * Trader: Cancelled, Returned to Branch, Returned to Trader -- and a Returned
 * to Trader Order that has since been Closed (its delivery status is then
 * `closed`; `return_status` keeps `returned_to_trader`). Written once and used
 * by both selection paths so they cannot disagree.
 */
const RETURNED_ORDER_PREDICATE = sql`(
  o.delivery_status in ('cancelled', 'returned_to_branch', 'returned_to_trader')
  or o.return_status = 'returned_to_trader'
)`;

function returnKind(row: ReturnedOrderRow): ReturnedItemsOrder["returnKind"] {
  if (row.deliveryStatus === "cancelled") return "cancelled";
  if (row.deliveryStatus === "returned_to_branch") return "returned_to_branch";
  return "returned_to_trader";
}

const ROW_COLUMNS = sql`
  o.serial_number as "serialNumber", o.order_number as "orderNumber",
  o.reference_number as "referenceNumber", o.trader_id as "traderId",
  coalesce(o.customer_name, '') as "customerName",
  coalesce(o.customer_mobile_number, '') as "customerMobileNumber",
  coalesce(a.name_en, '') as "areaName",
  o.cod_amount::text as "codAmount", coalesce(o.package_count, 1)::int as "packageCount",
  o.delivery_status as "deliveryStatus", o.return_status as "returnStatus",
  nullif(btrim(coalesce(o.delivery_reason, '')), '') as reason
`;

/**
 * Trader Returned Items: the Driver Shipment Manifest's counterpart for goods
 * going BACK to a Trader. One Trader per report; only Cancelled / Returned
 * Orders. Read-only: generated from live Order data on every request, never
 * stored, and nothing about the Orders changes.
 */
@Injectable()
export class TraderReturnedItemsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
  ) {}

  private assertAnyPermission(required: readonly string[]): void {
    const permissions = this.identities.current().permissions;
    if (
      !permissions.has("users_roles.manage") &&
      !required.some((candidate) => permissions.has(candidate))
    ) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async resolveOrdersByIds(
    companyId: string,
    orderIds: readonly string[],
  ): Promise<readonly ReturnedOrderRow[]> {
    if (orderIds.length === 0) return [];
    const result = await sql<ReturnedOrderRow>`
      select ${ROW_COLUMNS}
        from orders o
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
       where o.company_id = ${companyId}::uuid
         and o.id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`))})
       order by o.order_number
    `.execute(this.database);
    if (result.rows.length !== orderIds.length) {
      throw new ApplicationException(
        "returned_items_order_not_found",
        "One or more selected Orders could not be found for this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return result.rows;
  }

  /** "Select all matching": the Orders list's own filters, limited to returned goods. */
  private async resolveOrdersByFilter(
    companyId: string,
    input: GenerateShipmentManifestDto,
  ): Promise<readonly ReturnedOrderRow[]> {
    const excluded = input.excludedOrderIds ?? [];
    const search = input.search?.trim() || null;
    const result = await sql<ReturnedOrderRow>`
      select ${ROW_COLUMNS}
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
       where o.company_id = ${companyId}::uuid
         and ${RETURNED_ORDER_PREDICATE}
         and (${search}::text is null
           or o.order_number ilike '%' || ${search} || '%'
           or o.serial_number ilike '%' || ${search} || '%'
           or o.reference_number ilike '%' || ${search} || '%'
           or o.customer_name ilike '%' || ${search} || '%'
           or o.customer_mobile_number ilike '%' || ${search} || '%'
           or t.name_en ilike '%' || ${search} || '%')
         and ${deliveryStatusFilterPredicate(input.deliveryStatus)}
         and (${input.orderType ?? null}::text is null or o.order_type = ${input.orderType ?? null})
         and (${input.driverId ?? null}::uuid is null
           or o.assigned_driver_id = ${input.driverId ?? null}::uuid)
         and (${input.areaId ?? null}::uuid is null or o.area_id = ${input.areaId ?? null}::uuid)
         and (${input.traderId ?? null}::uuid is null
           or o.trader_id = ${input.traderId ?? null}::uuid)
         and (${input.dateFrom ?? null}::date is null
           or o.order_date >= ${input.dateFrom ?? null}::date)
         and (${input.dateTo ?? null}::date is null or o.order_date <= ${input.dateTo ?? null}::date)
         and (${excluded.length} = 0 or o.id not in (
           ${sql.join(excluded.length > 0 ? excluded.map((id) => sql`${id}::uuid`) : [sql`null::uuid`])}
         ))
       order by o.order_number
    `.execute(this.database);
    return result.rows;
  }

  /** The selection, validated: at least one Order, every one Cancelled / Returned. */
  private async selectedReturnedOrders(
    companyId: string,
    input: GenerateShipmentManifestDto,
  ): Promise<readonly ReturnedOrderRow[]> {
    this.assertAnyPermission([
      "reports.export",
      "orders.assign_driver",
      "orders.update_delivery_status",
    ]);
    const orders = await (input.selectionMode === "ids"
      ? this.resolveOrdersByIds(companyId, input.orderIds ?? [])
      : this.resolveOrdersByFilter(companyId, input));
    if (orders.length === 0) {
      throw new ApplicationException(
        "returned_items_empty",
        "Select at least one Cancelled or Returned Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const notReturned = orders.filter(
      (row) =>
        !["cancelled", "returned_to_branch", "returned_to_trader"].includes(row.deliveryStatus) &&
        row.returnStatus !== "returned_to_trader",
    );
    if (notReturned.length > 0) {
      throw new ApplicationException(
        "returned_items_order_not_returned",
        "Only Cancelled or Returned Orders can be on the Returned Items report",
        HttpStatus.CONFLICT,
        notReturned.map((row) => row.orderNumber),
      );
    }
    return orders;
  }

  /**
   * One report is ONE Trader's (Aiman, 13 Oct 2026: a selection spanning
   * several Traders produces one separate PDF per Trader, never a combined
   * one). `traderId` picks that Trader's Orders out of the selection; without
   * it the selection must already be a single Trader's.
   */
  private async buildData(
    companyId: string,
    input: GenerateShipmentManifestDto,
    requestedTraderId?: string,
  ): Promise<ReturnedItemsData> {
    const selected = await this.selectedReturnedOrders(companyId, input);
    if (requestedTraderId !== undefined && !UUID.test(requestedTraderId)) {
      throw new ApplicationException(
        "returned_items_trader_invalid",
        "The Trader is not valid",
        HttpStatus.BAD_REQUEST,
      );
    }
    const orders =
      requestedTraderId === undefined
        ? selected
        : selected.filter((row) => row.traderId === requestedTraderId);
    if (orders.length === 0) {
      throw new ApplicationException(
        "returned_items_trader_not_in_selection",
        "None of the selected Orders belongs to this Trader",
        HttpStatus.BAD_REQUEST,
      );
    }
    const traderIds = new Set(orders.map((row) => row.traderId));
    if (traderIds.size !== 1) {
      throw new ApplicationException(
        "returned_items_trader_mismatch",
        "The selected Orders belong to several Traders; print one report per Trader.",
        HttpStatus.CONFLICT,
      );
    }
    const traderId = orders[0]!.traderId;
    const trader = (
      await sql<{ mobileNumber: string | null; nameEn: string }>`
        select name_en as "nameEn", mobile_number as "mobileNumber"
          from traders where id = ${traderId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (trader === undefined) {
      throw new ApplicationException(
        "trader_not_found",
        "The selected Trader does not belong to this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    const identity = this.identities.current();
    const generatedBy = (
      await sql<{ username: string }>`
        select username from accounts
         where id = ${identity.identityId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0]?.username;
    const branding = await this.companyProfile.branding();
    const logoDataUri = branding.hasLogo
      ? await this.companyProfile
          .logoContent()
          .then((logo) => `data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`)
          .catch(() => null)
      : null;
    const mapped = orders.map<ReturnedItemsOrder>((row) => ({
      areaName: row.areaName,
      codAmount: new Decimal(row.codAmount).toFixed(2),
      customerMobileNumber: row.customerMobileNumber,
      customerName: row.customerName,
      orderNumber: row.orderNumber,
      packageCount: Number(row.packageCount),
      reason: row.reason,
      referenceNumber: row.referenceNumber,
      returnKind: returnKind(row),
      serialNumber: row.serialNumber ?? row.orderNumber,
    }));
    return {
      header: {
        company: {
          hasLogo: branding.hasLogo,
          logoDataUri,
          nameAr: branding.nameAr,
          nameEn: branding.nameEn,
          subtitleAr: branding.subtitleAr,
          subtitleEn: branding.subtitleEn,
          telephone: branding.telephone,
        },
        generatedBy: generatedBy ?? "—",
        orderCount: mapped.length,
        // Display-only, never persisted: regenerated from live data each time.
        reportNumber: `RET-${Date.now().toString(36).toUpperCase()}`,
        traderMobile: trader.mobileNumber,
        traderName: trader.nameEn,
      },
      orders: mapped,
      summary: {
        countCancelled: mapped.filter((row) => row.returnKind === "cancelled").length,
        countReturned: mapped.filter((row) => row.returnKind !== "cancelled").length,
        totalOrders: mapped.length,
        totalPackages: mapped.reduce((sum, row) => sum + row.packageCount, 0),
        totalValue: mapped
          .reduce((sum, row) => sum.plus(row.codAmount), new Decimal(0))
          .toFixed(2),
      },
    };
  }

  private generatedAt(): string {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
  }

  private fileStem(data: ReturnedItemsData): string {
    const trader = data.header.traderName.replaceAll(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
    return `Trader-Returned-Items-${trader === "" ? "Trader" : trader}-${date}`;
  }

  /** The selection split by Trader: one row, and later one report, per Trader. */
  public async traders(input: GenerateShipmentManifestDto): Promise<ReturnedItemsTraders> {
    const { companyId } = this.tenants.current();
    const orders = await this.selectedReturnedOrders(companyId, input);
    const ids = [...new Set(orders.map((row) => row.traderId))];
    const names = await sql<{ id: string; nameEn: string }>`
      select id, name_en as "nameEn" from traders
       where company_id = ${companyId}::uuid
         and id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
    `.execute(this.database);
    const nameOf = new Map(names.rows.map((row) => [row.id, row.nameEn]));
    return {
      traders: ids
        .map((traderId) => {
          const own = orders.filter((row) => row.traderId === traderId);
          return {
            orderCount: own.length,
            totalPackages: own.reduce((sum, row) => sum + Number(row.packageCount), 0),
            totalValue: own
              .reduce((sum, row) => sum.plus(row.codAmount), new Decimal(0))
              .toFixed(2),
            traderId,
            traderName: nameOf.get(traderId) ?? "—",
          };
        })
        .sort((left, right) => left.traderName.localeCompare(right.traderName)),
    };
  }

  public async data(
    input: GenerateShipmentManifestDto,
    traderId?: string,
  ): Promise<ReturnedItemsData> {
    const { companyId } = this.tenants.current();
    return this.buildData(companyId, input, traderId);
  }

  public async pdfReport(
    input: GenerateShipmentManifestDto,
    language: ReportLanguage,
    traderId?: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    const { companyId } = this.tenants.current();
    const data = await this.buildData(companyId, input, traderId);
    const html = buildTraderReturnedItemsHtml(data, language, `${this.generatedAt()} (UAE)`);
    const footerTemplate =
      language === "ar"
        ? `<div style="font-size:9px;width:100%;text-align:center;color:#666;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`
        : `<div style="font-size:9px;width:100%;text-align:center;color:#666;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
    const bytes = await this.pdf.renderPdf(html, footerTemplate);
    return { bytes, filename: `${this.fileStem(data)}.pdf` };
  }

  public async excelReport(
    input: GenerateShipmentManifestDto,
    language: ReportLanguage = "en",
    traderId?: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    const { companyId } = this.tenants.current();
    const data = await this.buildData(companyId, input, traderId);
    const columns = [...returnedItemsColumns(language)];
    const rows = data.orders.map((row) =>
      Object.fromEntries(
        [
          row.serialNumber,
          row.referenceNumber ?? "",
          row.customerName,
          row.customerMobileNumber,
          row.areaName,
          returnedItemsKindLabel(row.returnKind, language),
          row.reason ?? "",
          row.packageCount,
          row.codAmount,
        ].map((value, index) => [columns[index]!, value]),
      ),
    );
    const bytes = accountingXlsx(columns, rows, [
      [returnedItemsTitle(language), `${this.generatedAt()} (UAE)`],
      [language === "ar" ? "التاجر" : "Trader", data.header.traderName],
      [language === "ar" ? "عدد الطلبات" : "Orders", data.header.orderCount],
    ]);
    return { bytes, filename: `${this.fileStem(data)}.xlsx` };
  }
}
