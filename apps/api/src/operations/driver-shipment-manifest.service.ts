import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { accountingXlsx } from "../accounting/accounting-xlsx.js";
import { type Kysely, sql } from "kysely";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import type { ReportLanguage } from "./driver-collection-report-html.js";
import {
  buildDriverShipmentManifestHtml,
  type ManifestData,
} from "./driver-shipment-manifest-html.js";
import type { GenerateShipmentManifestDto } from "./operations.dto.js";

const deliveryStatusLabels: Record<string, string> = {
  assigned_to_driver: "Assigned to Driver",
  cancelled: "Cancelled",
  closed: "Closed",
  delivered: "Delivered",
  hold: "Hold",
  in_branch: "Item in Branch",
  new: "New",
  out_for_delivery: "Out for Delivery",
  returned_to_branch: "Returned to Branch",
  returned_to_trader: "Returned to Trader",
};

interface ManifestOrderRow {
  readonly areaName: string;
  readonly assignedDriverId: string | null;
  readonly codAmount: string;
  readonly customerMobileNumber: string;
  readonly customerName: string;
  readonly customerSecondMobileNumber: string | null;
  readonly deliveryInstructions: string | null;
  readonly deliveryStatus: string;
  readonly emirateName: string | null;
  readonly notes: string | null;
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string | null;
  readonly traderName: string;
}

@Injectable()
export class DriverShipmentManifestService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
  ) {}

  private assertAnyPermission(permission: string | readonly string[]): void {
    const permissions = this.identities.current().permissions;
    const required = Array.isArray(permission) ? permission : [permission];
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

  /**
   * Resolves and validates the selected Orders for a Manifest: current Company
   * ownership, every Order assigned to the same Driver, and at least one Order.
   * No collection or reconciliation eligibility is required. Explicit Order-ID
   * selections remain reportable after delivery, collection, reconciliation,
   * closure, return, or cancellation.
   */
  private async resolveOrders(
    companyId: string,
    input: GenerateShipmentManifestDto,
  ): Promise<{ driverId: string; orders: readonly ManifestOrderRow[] }> {
    const rows = await (input.selectionMode === "ids"
      ? this.resolveOrdersByIds(companyId, input.orderIds ?? [])
      : this.resolveOrdersByFilter(companyId, input));
    if (rows.length === 0) {
      throw new ApplicationException(
        "manifest_empty",
        "Select at least one Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const driverIds = new Set(rows.map((row) => row.assignedDriverId));
    if (driverIds.size !== 1 || driverIds.has(null)) {
      throw new ApplicationException(
        "manifest_driver_mismatch",
        "Select Orders assigned to one Driver only.",
        HttpStatus.CONFLICT,
      );
    }
    const driverId = rows[0]?.assignedDriverId;
    if (driverId === null || driverId === undefined) {
      throw new ApplicationException(
        "manifest_driver_mismatch",
        "Select Orders assigned to one Driver only.",
        HttpStatus.CONFLICT,
      );
    }
    return { driverId, orders: rows };
  }

  private async resolveOrdersByIds(
    companyId: string,
    orderIds: readonly string[],
  ): Promise<readonly ManifestOrderRow[]> {
    if (orderIds.length === 0) return [];
    const result = await sql<ManifestOrderRow>`
      select o.serial_number as "serialNumber", o.order_number as "orderNumber",
             o.reference_number as "referenceNumber", o.assigned_driver_id as "assignedDriverId",
             t.name_en as "traderName", coalesce(o.customer_name, '') as "customerName",
             coalesce(o.customer_mobile_number, '') as "customerMobileNumber",
             o.customer_second_mobile_number as "customerSecondMobileNumber",
             e.name_en as "emirateName", coalesce(a.name_en, '') as "areaName",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.customer_delivery_notes_snapshot as "deliveryInstructions", o.notes,
             o.delivery_status as "deliveryStatus"
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
        left join emirates e on e.id = a.emirate_id
       where o.company_id = ${companyId}::uuid
         and o.id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`))})
       order by o.delivered_at nulls last, o.order_number
    `.execute(this.database);
    if (result.rows.length !== orderIds.length) {
      throw new ApplicationException(
        "manifest_order_not_found",
        "One or more selected Orders could not be found for this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return result.rows;
  }

  /**
   * Resolves a "select all matching" filter selection the same way the Orders
   * list itself filters (driver/area/trader/date range), scoped to Orders
   * currently assigned to a Driver. Unlike collection eligibility, these
   * predicates mirror the Orders list selection itself, including historical
   * quick views and financial-status filters.
   */
  private async resolveOrdersByFilter(
    companyId: string,
    input: GenerateShipmentManifestDto,
  ): Promise<readonly ManifestOrderRow[]> {
    const excluded = input.excludedOrderIds ?? [];
    const result = await sql<ManifestOrderRow>`
      select o.serial_number as "serialNumber", o.order_number as "orderNumber",
             o.reference_number as "referenceNumber", o.assigned_driver_id as "assignedDriverId",
             t.name_en as "traderName", coalesce(o.customer_name, '') as "customerName",
             coalesce(o.customer_mobile_number, '') as "customerMobileNumber",
             o.customer_second_mobile_number as "customerSecondMobileNumber",
             e.name_en as "emirateName", coalesce(a.name_en, '') as "areaName",
             o.cod_amount::text as "codAmount",
             o.service_fee::text as "serviceFee",
             o.customer_delivery_notes_snapshot as "deliveryInstructions", o.notes,
             o.delivery_status as "deliveryStatus"
        from orders o
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
        left join areas a on a.id = o.area_id and a.company_id = o.company_id
        left join emirates e on e.id = a.emirate_id
       where o.company_id = ${companyId}::uuid
         and o.assigned_driver_id is not null
         and (${input.search?.trim() || null}::text is null
           or o.order_number ilike '%' || ${input.search?.trim() || null} || '%'
           or o.serial_number ilike '%' || ${input.search?.trim() || null} || '%'
           or o.customer_name ilike '%' || ${input.search?.trim() || null} || '%'
           or o.customer_mobile_number ilike '%' || ${input.search?.trim() || null} || '%'
           or t.name_en ilike '%' || ${input.search?.trim() || null} || '%')
         and (${input.quickView ?? "active"} = 'all'
           or (${input.quickView ?? "active"} = 'active'
             and o.delivery_status in ('new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch','returned_to_trader','collect_order'))
           or (${input.quickView ?? "active"} = 'hold' and o.delivery_status = 'hold')
           or (${input.quickView ?? "active"} = 'closed' and o.delivery_status = 'closed')
           or (${input.quickView ?? "active"} = 'cancelled' and o.delivery_status = 'cancelled'))
         and (${input.deliveryStatus?.trim() || null}::text is null
           or o.delivery_status = ${input.deliveryStatus?.trim() || null})
         and (${input.orderType ?? null}::text is null or o.order_type=${input.orderType ?? null})
         and (${input.cashStatus?.trim() || null}::text is null
           or o.driver_reconciliation_status = ${input.cashStatus?.trim() || null})
         and (${input.settlementStatus?.trim() || null}::text is null
           or o.trader_settlement_status = ${input.settlementStatus?.trim() || null})
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
       order by o.delivered_at nulls last, o.order_number
    `.execute(this.database);
    return result.rows;
  }

  private async buildManifestData(
    companyId: string,
    input: GenerateShipmentManifestDto,
  ): Promise<ManifestData> {
    this.assertAnyPermission([
      "reports.export",
      "orders.assign_driver",
      "orders.update_delivery_status",
    ]);
    const identity = this.identities.current();
    const { driverId, orders } = await this.resolveOrders(companyId, input);
    const cancelledOrders = orders.filter((order) => order.deliveryStatus === "cancelled");
    if (cancelledOrders.length > 0) {
      throw new ApplicationException(
        "manifest_order_cancelled",
        "Cancelled Orders cannot be included in a Driver shipment manifest",
        HttpStatus.CONFLICT,
        cancelledOrders.map((order) => order.orderNumber),
      );
    }
    const driverResult = await sql<{
      driverType: "employee" | "outsourced";
      mobileNumber: string;
      nameEn: string;
    }>`
      select name_en as "nameEn", mobile_number as "mobileNumber", driver_type as "driverType"
        from drivers where id = ${driverId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    const driver = driverResult.rows[0];
    if (driver === undefined) {
      throw new ApplicationException(
        "driver_not_found",
        "The selected Driver does not belong to this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    const generatedByResult = await sql<{ username: string }>`
      select username from accounts where id = ${identity.identityId}::uuid and company_id = ${companyId}::uuid
    `.execute(this.database);
    const branding = await this.companyProfile.branding();
    const logoDataUri = branding.hasLogo
      ? await this.companyProfile
          .logoContent()
          .then((logo) => `data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`)
          .catch(() => null)
      : null;
    const totalCod = orders.reduce((sum, row) => sum.plus(row.codAmount), new Decimal(0));
    const countBy = (status: string) =>
      orders.filter((row) => row.deliveryStatus === status).length;
    // A short, non-persisted reference for display only — the Manifest is
    // regenerated from live Order data on every request, never stored.
    const manifestNumber = `MAN-${Date.now().toString(36).toUpperCase()}`;
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
        driverMobile: driver.mobileNumber,
        driverName: driver.nameEn,
        driverType: driver.driverType,
        generatedBy: generatedByResult.rows[0]?.username ?? "—",
        manifestNumber,
        orderCount: orders.length,
      },
      orders: orders.map((row) => ({
        areaName: row.areaName,
        codAmount: new Decimal(row.codAmount).toFixed(2),
        customerMobileNumber: row.customerMobileNumber,
        customerName: row.customerName,
        customerSecondMobileNumber: row.customerSecondMobileNumber,
        deliveryInstructions: row.deliveryInstructions,
        deliveryStatus: row.deliveryStatus,
        deliveryStatusLabel: deliveryStatusLabels[row.deliveryStatus] ?? row.deliveryStatus,
        emirateName: row.emirateName,
        notes: row.notes,
        orderNumber: row.orderNumber,
        referenceNumber: row.referenceNumber,
        serialNumber: row.serialNumber ?? row.orderNumber,
        serviceFee: new Decimal(row.serviceFee).toFixed(2),
        traderName: row.traderName,
      })),
      summary: {
        countAssignedToDriver: countBy("assigned_to_driver"),
        countCancelled: countBy("cancelled"),
        countDelivered: countBy("delivered"),
        countNew: countBy("new"),
        countOutForDelivery: countBy("out_for_delivery"),
        countReturned: countBy("returned_to_branch") + countBy("returned_to_trader"),
        totalCod: totalCod.toFixed(2),
        totalOrders: orders.length,
      },
    };
  }

  public async manifestData(input: GenerateShipmentManifestDto): Promise<ManifestData> {
    const { companyId } = this.tenants.current();
    return this.buildManifestData(companyId, input);
  }

  public async manifestPdf(
    input: GenerateShipmentManifestDto,
    language: ReportLanguage,
  ): Promise<{ bytes: Buffer; filename: string }> {
    const { companyId } = this.tenants.current();
    const data = await this.buildManifestData(companyId, input);
    const generatedAt = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
    const html = buildDriverShipmentManifestHtml(data, language, `${generatedAt} (UAE)`);
    const footerTemplate =
      language === "ar"
        ? `<div style="font-size:9px;width:100%;text-align:center;color:#666;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`
        : `<div style="font-size:9px;width:100%;text-align:center;color:#666;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
    const bytes = await this.pdf.renderPdf(html, footerTemplate);
    // Safe filename (§9): built only from the Driver's name and today's UAE
    // date, both allowlist-stripped defensively rather than trusted as-is.
    const safeDriverName = data.header.driverName.replaceAll(/[^A-Za-z0-9]+/g, "-");
    const dateStamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(
      new Date(),
    );
    const filename = `Driver-Manifest-${safeDriverName}-${dateStamp}.pdf`;
    return { bytes, filename };
  }

  public async manifestExcel(
    input: GenerateShipmentManifestDto,
  ): Promise<{ bytes: Buffer; filename: string }> {
    const { companyId } = this.tenants.current();
    const data = await this.buildManifestData(companyId, input);
    const generatedAt = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
    const columns = [
      "serialNumber",
      "referenceNumber",
      "traderName",
      "customerName",
      "customerMobileNumber",
      "areaName",
      "codAmount",
      "notes",
    ];
    const rows = data.orders.map((row) => ({
      serialNumber: row.serialNumber,
      referenceNumber: row.referenceNumber ?? "",
      traderName: row.traderName,
      customerName: row.customerName,
      customerMobileNumber: row.customerMobileNumber,
      areaName: row.areaName,
      codAmount: row.codAmount,
      notes: row.notes ?? "",
    }));
    const bytes = accountingXlsx(columns, rows, [
      ["Manifest Date and Time", `${generatedAt} (UAE)`],
      ["Driver", data.header.driverName],
      ["Orders", data.header.orderCount],
    ]);
    const safe = data.header.driverName.replaceAll(/[^A-Za-z0-9]+/g, "-");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
    return { bytes, filename: `Driver-Shipment-Manifest-${safe}-${date}.xlsx` };
  }
}
