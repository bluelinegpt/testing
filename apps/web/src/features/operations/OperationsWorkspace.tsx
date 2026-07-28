import { Fragment, type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { reconciliationPageSizes } from "../../api/contracts.js";
import { DriverCashStatusLabel, useDriverCashStatusLabel } from "./DriverCashStatus.js";
import { ReconciliationPrintReport } from "./ReconciliationPrintReport.js";
import type { ApiClient } from "../../api/api-client.js";
import type {
  AreaPage,
  CompanyArea,
  OperationsDriverReconciliation,
  OperationsDriverReconciliationDetail,
  PagedResponse,
  ReconciliationPageSize,
  OperationsBillingSummary,
  OperationsDriver,
  OperationsExportFile,
  OperationsInternationalShipment,
  OperationsOrderAttachment,
  OperationsOrderDetail,
  OperationsOrderImportResult,
  OperationsOrder,
  OperationsOrderPage,
  OperationsPendingCashOrder,
  OperationsTrackingLink,
  OperationsTrader,
} from "../../api/contracts.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { CreateOrderDialog as ModernCreateOrderDialog } from "./CreateOrderDialog.js";

export type OperationsView = "orders" | "cash" | "drivers" | "reports";

interface OrderFilters {
  readonly areaId: string;
  readonly cashStatus: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly deliveryStatus: string;
  readonly driverId: string;
  readonly search: string;
  readonly settlementStatus: string;
  readonly traderId: string;
}

export function OperationsWorkspace({
  api,
  initialDialog,
  initialView = "orders",
  onNavigate,
  pageSectionKey,
  pageTitleKey,
  permissions = [],
}: {
  api: ApiClient;
  initialDialog?: "create-order" | "import-orders";
  initialView?: OperationsView;
  onNavigate?: (path: string) => void;
  pageSectionKey?: string;
  pageTitleKey?: string;
  permissions?: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const [view, setView] = useState<OperationsView>(initialView);
  const [billing, setBilling] = useState<OperationsBillingSummary>();
  const [orders, setOrders] = useState<readonly OperationsOrder[]>([]);
  const [areas, setAreas] = useState<readonly CompanyArea[]>([]);
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [drivers, setDrivers] = useState<readonly OperationsDriver[]>([]);
  const [pendingCashOrders, setPendingCashOrders] = useState<readonly OperationsPendingCashOrder[]>(
    [],
  );
  const [orderFilters, setOrderFilters] = useState<OrderFilters>({
    areaId: "",
    cashStatus: "",
    dateFrom: "",
    dateTo: "",
    deliveryStatus: "",
    driverId: "",
    search: "",
    settlementStatus: "",
    traderId: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [importOrdersOpen, setImportOrdersOpen] = useState(false);
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const canViewOrders =
    permissions.includes("users_roles.manage") ||
    permissions.includes("orders.edit_before_processing") ||
    permissions.includes("orders.assign_driver") ||
    permissions.includes("orders.update_delivery_status");
  const dialogOnly = initialDialog !== undefined && !canViewOrders;

  useEffect(() => setView(initialView), [initialView]);

  useEffect(() => {
    if (initialDialog === "create-order") setCreateOrderOpen(true);
    if (initialDialog === "import-orders") setImportOrdersOpen(true);
  }, [initialDialog]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    if (dialogOnly) {
      try {
        if (initialDialog === "create-order") {
          setDrivers(await api.get<readonly OperationsDriver[]>("operations/drivers"));
        }
      } catch {
        setError(t("common.loadFailed"));
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      const [loadedBilling, loadedOrders, loadedAreas, loadedTraders, loadedDrivers, loadedCash] =
        await Promise.all([
          api.get<OperationsBillingSummary>("operations/billing/summary"),
          api.get<OperationsOrderPage>(operationsOrdersPath(orderFilters)),
          api.get<AreaPage>("configuration/areas?page=1&pageSize=100&status=active"),
          api.get<readonly OperationsTrader[]>("operations/traders"),
          api.get<readonly OperationsDriver[]>("operations/drivers"),
          api.get<readonly OperationsPendingCashOrder[]>("operations/cash/pending"),
        ]);
      setBilling(loadedBilling);
      setOrders(loadedOrders.items);
      // The request already asks for active Areas only.
      setAreas(loadedAreas.items);
      setTraders(loadedTraders);
      setDrivers(loadedDrivers);
      setPendingCashOrders(loadedCash);
    } catch {
      setError(t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, dialogOnly, initialDialog, orderFilters, t]);

  useEffect(() => void load(), [load]);

  const changeOrderStatus = async (order: OperationsOrder, status: string) => {
    setError(undefined);
    try {
      await api.patch<OperationsOrder>(`operations/orders/${order.id}/status`, { status });
      await load();
      setView("orders");
    } catch {
      setError(t("operations.workflowFailed"));
    }
  };

  return (
    <>
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <PageHeader
        actions={
          <>
            <button className="button button-secondary" onClick={() => void load()} type="button">
              {t("common.refresh")}
            </button>
            {view === "orders" ? (
              <>
                <button
                  className="button button-primary"
                  disabled={traders.length === 0 || areas.length === 0}
                  onClick={() => setCreateOrderOpen(true)}
                  type="button"
                >
                  {t("operations.createOrder")}
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => setImportOrdersOpen(true)}
                  type="button"
                >
                  {t("operations.importOrders")}
                </button>
              </>
            ) : null}
            {view === "drivers" ? (
              <button
                className="button button-primary"
                onClick={() => onNavigate?.("/configuration/drivers")}
                type="button"
              >
                {t("operations.createDriver")}
              </button>
            ) : null}
          </>
        }
        eyebrow={t(pageSectionKey ?? operationsSectionKey(view))}
        title={t(pageTitleKey ?? operationsTitleKey(view))}
      />

      <div className="data-surface">
        {view === "orders" ? (
          <OrdersTable
            api={api}
            filters={orderFilters}
            locale={locale}
            orders={orders}
            areas={areas}
            drivers={drivers}
            traders={traders}
            onFiltersChange={setOrderFilters}
            onStatusChange={(order, status) => void changeOrderStatus(order, status)}
          />
        ) : view === "cash" ? (
          <CashTable
            api={api}
            onNavigate={(target) => onNavigate?.(target)}
            orders={pendingCashOrders}
          />
        ) : view === "drivers" ? (
          <DriversTable drivers={drivers} />
        ) : (
          <ReportsPanel api={api} billing={billing} filters={orderFilters} />
        )}
        {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
      </div>

      {createOrderOpen ? (
        <ModernCreateOrderDialog
          api={api}
          drivers={drivers}
          permissions={permissions}
          onClose={() => {
            setCreateOrderOpen(false);
            if (initialDialog === "create-order") {
              onNavigate?.(canViewOrders ? "/orders" : "/no-access");
            }
          }}
          onSaved={async () => {
            if (canViewOrders) {
              await load();
              setView("orders");
              onNavigate?.("/orders");
            }
          }}
        />
      ) : null}
      {importOrdersOpen ? (
        <ImportOrdersDialog
          api={api}
          onClose={() => {
            setImportOrdersOpen(false);
            if (initialDialog === "import-orders") {
              onNavigate?.(canViewOrders ? "/orders" : "/no-access");
            }
          }}
          onImported={async () => {
            if (canViewOrders) {
              await load();
              setView("orders");
              onNavigate?.("/orders");
            }
          }}
        />
      ) : null}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function OrdersTable({
  api,
  areas,
  drivers,
  filters,
  locale,
  onFiltersChange,
  onStatusChange,
  orders,
  traders,
}: {
  api: ApiClient;
  areas: readonly CompanyArea[];
  drivers: readonly OperationsDriver[];
  filters: OrderFilters;
  locale: "ar" | "en";
  onFiltersChange: (filters: OrderFilters) => void;
  onStatusChange: (order: OperationsOrder, status: string) => void;
  orders: readonly OperationsOrder[];
  traders: readonly OperationsTrader[];
}) {
  const { t } = useTranslation();
  const cashStatusLabel = useDriverCashStatusLabel();
  const [detail, setDetail] = useState<OperationsOrderDetail>();
  const [detailError, setDetailError] = useState<string>();
  const toggleDetail = async (order: OperationsOrder) => {
    if (detail?.id === order.id) {
      setDetail(undefined);
      return;
    }
    setDetailError(undefined);
    try {
      setDetail(await api.get<OperationsOrderDetail>(`operations/orders/${order.id}`));
    } catch {
      setDetailError(t("operations.detailLoadFailed"));
    }
  };
  return (
    <>
      <div className="table-toolbar">
        <label className="field compact-field">
          <span>{t("operations.searchOrders")}</span>
          <input
            maxLength={80}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            value={filters.search}
          />
        </label>
        <label className="field compact-field">
          <span>{t("operations.trader")}</span>
          <select
            onChange={(event) => onFiltersChange({ ...filters, traderId: event.target.value })}
            value={filters.traderId}
          >
            <option value="">{t("operations.all")}</option>
            {traders.map((trader) => (
              <option key={trader.id} value={trader.id}>
                {trader.code} - {trader.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span>{t("operations.driver")}</span>
          <select
            onChange={(event) => onFiltersChange({ ...filters, driverId: event.target.value })}
            value={filters.driverId}
          >
            <option value="">{t("operations.all")}</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.code} - {driver.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span>{t("operations.areaField")}</span>
          <select
            onChange={(event) => onFiltersChange({ ...filters, areaId: event.target.value })}
            value={filters.areaId}
          >
            <option value="">{t("operations.all")}</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {locale === "ar" ? (area.nameAr ?? area.nameEn) : area.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span>{t("operations.deliveryStatus")}</span>
          <select
            onChange={(event) =>
              onFiltersChange({ ...filters, deliveryStatus: event.target.value })
            }
            value={filters.deliveryStatus}
          >
            <option value="">{t("operations.all")}</option>
            {deliveryStatusOptions.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span>{t("operations.dateFrom")}</span>
          <input
            max={filters.dateTo || undefined}
            onChange={(event) => onFiltersChange({ ...filters, dateFrom: event.target.value })}
            type="date"
            value={filters.dateFrom}
          />
        </label>
        <label className="field compact-field">
          <span>{t("operations.dateTo")}</span>
          <input
            min={filters.dateFrom || undefined}
            onChange={(event) => onFiltersChange({ ...filters, dateTo: event.target.value })}
            type="date"
            value={filters.dateTo}
          />
        </label>
        <label className="field compact-field">
          <span>{t("operations.cashStatus")}</span>
          <select
            onChange={(event) => onFiltersChange({ ...filters, cashStatus: event.target.value })}
            value={filters.cashStatus}
          >
            <option value="">{t("operations.all")}</option>
            {cashStatusOptions.map((status) => (
              <option key={status} value={status}>
                {cashStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact-field">
          <span>{t("operations.settlementStatus")}</span>
          <select
            onChange={(event) =>
              onFiltersChange({ ...filters, settlementStatus: event.target.value })
            }
            value={filters.settlementStatus}
          >
            <option value="">{t("operations.all")}</option>
            {settlementStatusOptions.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button-secondary"
          onClick={() =>
            onFiltersChange({
              areaId: "",
              cashStatus: "",
              dateFrom: "",
              dateTo: "",
              deliveryStatus: "",
              driverId: "",
              search: "",
              settlementStatus: "",
              traderId: "",
            })
          }
          type="button"
        >
          {t("operations.clearFilters")}
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("operations.order")}</th>
            <th>{t("operations.trader")}</th>
            <th>{t("operations.customer")}</th>
            <th>{t("operations.assignedDriver")}</th>
            <th>{t("operations.cod")}</th>
            <th>{t("operations.status")}</th>
            <th>{t("operations.cash")}</th>
            <th>{t("operations.settlement")}</th>
            <th>
              <span className="sr-only">{t("common.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <Fragment key={order.id}>
              <tr>
                <td>
                  <strong>{order.orderNumber}</strong>
                  <span className="cell-secondary">{formatDate(order.orderDate, locale)}</span>
                </td>
                <td>
                  {order.traderName}
                  <span className="cell-secondary">{order.areaName}</span>
                </td>
                <td>
                  {order.customerName}
                  <span className="cell-secondary">{order.customerMobileNumber}</span>
                </td>
                <td>{order.assignedDriverName ?? t("operations.unassigned")}</td>
                <td>
                  {formatMoney(order.codAmount)}
                  <span className="cell-secondary">
                    {t("operations.customerAmountDue")}: {formatMoney(order.customerAmountDue)}
                  </span>
                </td>
                <td>
                  <span className="status status-neutral">
                    {t(`statuses.${order.deliveryStatus}`)}
                  </span>
                </td>
                <td>
                  <DriverCashStatusLabel value={order.driverReconciliationStatus} />
                </td>
                <td>{t(`statuses.${order.traderSettlementStatus}`)}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => void toggleDetail(order)} type="button">
                      {detail?.id === order.id
                        ? t("operations.hideDetails")
                        : t("operations.viewDetails")}
                    </button>
                    {nextOrderActions(order.deliveryStatus).map((action) => (
                      <button
                        className={action.status === "cancelled" ? "danger-link" : undefined}
                        key={action.status}
                        onClick={() => onStatusChange(order, action.status)}
                        type="button"
                      >
                        {t(`operations.${action.label}`)}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
              {detail?.id === order.id ? (
                <tr>
                  <td className="detail-cell" colSpan={9}>
                    <OrderDetail api={api} detail={detail} locale={locale} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
          {orders.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={9}>
                {t("operations.noOrders")}
              </td>
            </tr>
          ) : null}
          {detailError === undefined ? null : (
            <tr>
              <td className="empty-state" colSpan={9}>
                {detailError}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function operationsTitleKey(view: OperationsView): string {
  return {
    cash: "operations.cash",
    drivers: "operations.drivers",
    orders: "operations.orders",
    reports: "operations.reports",
  }[view];
}

function operationsSectionKey(view: OperationsView): string {
  return {
    cash: "nav.finance",
    drivers: "nav.drivers",
    orders: "nav.orders",
    reports: "nav.reports",
  }[view];
}

function ReportsPanel({
  api,
  billing,
  filters,
}: {
  api: ApiClient;
  billing: OperationsBillingSummary | undefined;
  filters: OrderFilters;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const exportOrders = async () => {
    setError(undefined);
    try {
      const file = await api.get<OperationsExportFile>(operationsOrdersExportPath(filters));
      downloadTextFile(file.filename, file.content, file.contentType);
    } catch {
      setError(t("operations.exportFailed"));
    }
  };

  return (
    <div className="reports-panel">
      <section className="report-actions">
        <div>
          <h2>{t("operations.reports")}</h2>
          <p>{t("operations.reportsSubtitle")}</p>
        </div>
        <button className="button button-primary" onClick={() => void exportOrders()} type="button">
          {t("operations.exportOrdersCsv")}
        </button>
      </section>
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <section className="report-grid">
        <Metric label={t("operations.plan")} value={billing?.planName ?? "-"} />
        <Metric label={t("operations.commercialStatus")} value={billing?.commercialStatus ?? "-"} />
        <Metric label={t("operations.billableOrders")} value={billing?.billableOrders ?? 0} />
      </section>
    </div>
  );
}

const deliveryStatusOptions = [
  "new",
  "assigned_to_driver",
  "out_for_delivery",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;

const cashStatusOptions = ["not_applicable", "pending", "reconciled", "reversed"] as const;

const settlementStatusOptions = [
  "not_eligible",
  "unsettled",
  "money_sent_to_trader",
  "money_received_by_trader",
  "reversed",
] as const;

const code128Patterns = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
] as const;

function OrderDetail({
  api,
  detail,
  locale,
}: {
  api: ApiClient;
  detail: OperationsOrderDetail;
  locale: "ar" | "en";
}) {
  const { t } = useTranslation();
  const [trackingLink, setTrackingLink] = useState<OperationsTrackingLink>();
  const [trackingError, setTrackingError] = useState<string>();
  const [attachments, setAttachments] = useState(detail.attachments);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [savingAttachment, setSavingAttachment] = useState(false);
  const [internationalShipment, setInternationalShipment] = useState(detail.internationalShipment);
  const [shipmentError, setShipmentError] = useState<string>();
  const [savingShipment, setSavingShipment] = useState(false);
  useEffect(() => {
    setAttachments(detail.attachments);
    setInternationalShipment(detail.internationalShipment);
  }, [detail.attachments, detail.internationalShipment]);
  const createTrackingLink = async () => {
    setTrackingError(undefined);
    try {
      const link = await api.post<OperationsTrackingLink>(
        `operations/orders/${detail.id}/tracking-links`,
      );
      setTrackingLink(link);
      await navigator.clipboard?.writeText(`${window.location.origin}${link.url}`).catch(() => {
        // The read-only field below remains the reliable fallback when clipboard access is blocked.
      });
    } catch {
      setTrackingError(t("operations.trackingLinkFailed"));
    }
  };
  const registerAttachment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttachmentError(undefined);
    setSavingAttachment(true);
    const data = new FormData(event.currentTarget);
    try {
      const attachment = await api.post<OperationsOrderAttachment>(
        `operations/orders/${detail.id}/attachments`,
        {
          attachmentType: String(data.get("attachmentType") ?? ""),
          fileName: String(data.get("fileName") ?? ""),
          mediaType: String(data.get("mediaType") ?? ""),
          sizeBytes: Number(data.get("sizeBytes") ?? 0),
        },
      );
      setAttachments([attachment, ...attachments]);
      event.currentTarget.reset();
    } catch {
      setAttachmentError(t("operations.attachmentSaveFailed"));
    } finally {
      setSavingAttachment(false);
    }
  };
  const registerInternationalShipment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setShipmentError(undefined);
    setSavingShipment(true);
    const data = new FormData(event.currentTarget);
    try {
      const shipment = await api.post<OperationsInternationalShipment>(
        `operations/orders/${detail.id}/international-shipment`,
        {
          currentStatus: String(data.get("currentStatus") ?? ""),
          customerCharge: Number(data.get("customerCharge") ?? 0),
          destinationCountryCode: String(data.get("destinationCountryCode") ?? "").toUpperCase(),
          internationalDeliveryCost: Number(data.get("internationalDeliveryCost") ?? 0),
          notes: optionalString(data.get("notes")),
          providerName: String(data.get("providerName") ?? ""),
          providerReferenceNumber: optionalString(data.get("providerReferenceNumber")),
        },
      );
      setInternationalShipment(shipment);
    } catch {
      setShipmentError(t("operations.shipmentSaveFailed"));
    } finally {
      setSavingShipment(false);
    }
  };
  return (
    <div className="detail-grid detail-grid-wide">
      <section>
        <div className="section-heading-inline">
          <h3>{t("operations.waybill")}</h3>
          <button
            className="button button-secondary button-compact"
            onClick={() =>
              openOrderWaybill(detail, locale, {
                address: t("operations.customerAddress"),
                amountDue: t("operations.customerAmountDue"),
                barcode: t("operations.barcode"),
                customer: t("operations.customer"),
                order: t("operations.order"),
                printTitle: t("operations.waybill"),
                serviceFee: t("operations.serviceFee"),
                trader: t("operations.trader"),
              })
            }
            type="button"
          >
            {t("operations.printWaybill")}
          </button>
        </div>
        <OrderBarcode value={detail.orderNumber} />
        <div className="detail-line">
          <span>{t("operations.barcode")}</span>
          <span>{detail.orderNumber}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.customerAddress")}</span>
          <span>{detail.customerAddress}</span>
        </div>
        <div className="tracking-link-panel">
          <button
            className="button button-secondary button-compact"
            onClick={createTrackingLink}
            type="button"
          >
            {t("operations.createTrackingLink")}
          </button>
          {trackingLink === undefined ? null : (
            <input
              aria-label={t("operations.trackingLink")}
              readOnly
              value={`${window.location.origin}${trackingLink.url}`}
            />
          )}
          {trackingError === undefined ? null : <p className="form-error">{trackingError}</p>}
        </div>
      </section>
      <section>
        <h3>{t("operations.financialSnapshot")}</h3>
        <div className="detail-line">
          <span>{t("operations.cod")}</span>
          <span>{formatMoney(detail.codAmount)}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.serviceFee")}</span>
          <span>{formatMoney(detail.serviceFee)}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.vatAmount")}</span>
          <span>{formatMoney(detail.vatAmount)}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.customerAmountDue")}</span>
          <span>{formatMoney(detail.customerAmountDue)}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.companyRevenue")}</span>
          <span>{formatMoney(detail.companyRevenue)}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.profit")}</span>
          <span>{formatMoney(detail.orderProfit)}</span>
        </div>
      </section>
      <section>
        <h3>{t("operations.statusTimeline")}</h3>
        {detail.history.map((item) => (
          <div className="detail-line" key={`${item.statusDimension}-${item.occurredAt}`}>
            <span>
              <strong>{t(`statusDimensions.${item.statusDimension}`)}</strong>
              <span className="cell-secondary">
                {item.fromStatus === null
                  ? t("operations.created")
                  : t(`statuses.${item.fromStatus}`)}{" "}
                - {t(`statuses.${item.toStatus}`)}
              </span>
            </span>
            <span>{formatDate(item.occurredAt, locale)}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>{t("operations.attachments")}</h3>
        <form className="attachment-form" onSubmit={(event) => void registerAttachment(event)}>
          <select aria-label={t("operations.attachmentType")} name="attachmentType" required>
            <option value="delivery_photo">{t("operations.deliveryPhoto")}</option>
            <option value="expense">{t("operations.expense")}</option>
            <option value="waybill">{t("operations.waybill")}</option>
            <option value="other">{t("operations.other")}</option>
          </select>
          <input
            aria-label={t("operations.fileName")}
            maxLength={180}
            name="fileName"
            placeholder={t("operations.fileName")}
            required
          />
          <input
            aria-label={t("operations.mediaType")}
            defaultValue="application/pdf"
            maxLength={100}
            name="mediaType"
            placeholder={t("operations.mediaType")}
            required
          />
          <input
            aria-label={t("operations.sizeBytes")}
            defaultValue="0"
            min="0"
            name="sizeBytes"
            type="number"
          />
          <button
            className="button button-secondary button-compact"
            disabled={savingAttachment}
            type="submit"
          >
            {savingAttachment ? t("common.working") : t("operations.registerAttachment")}
          </button>
        </form>
        {attachmentError === undefined ? null : <p className="form-error">{attachmentError}</p>}
        <div className="attachment-list">
          {attachments.map((attachment) => (
            <div className="attachment-row" key={attachment.id}>
              <span>
                <strong>{attachment.fileName}</strong>
                <span className="cell-secondary">
                  {t(`attachmentTypes.${attachment.attachmentType}`)} | {attachment.mediaType} |{" "}
                  {t(`statuses.${attachment.scanStatus}`)}
                </span>
              </span>
              <span>{formatDate(attachment.createdAt, locale)}</span>
            </div>
          ))}
          {attachments.length === 0 ? (
            <p className="empty-state-inline">{t("operations.noAttachments")}</p>
          ) : null}
        </div>
      </section>
      <section>
        <h3>{t("operations.internationalShipment")}</h3>
        {internationalShipment === null ? null : (
          <div className="shipment-summary">
            <div className="detail-line">
              <span>{t("operations.provider")}</span>
              <span>{internationalShipment.providerName}</span>
            </div>
            <div className="detail-line">
              <span>{t("operations.destinationCountry")}</span>
              <span>{internationalShipment.destinationCountryCode}</span>
            </div>
            <div className="detail-line">
              <span>{t("operations.status")}</span>
              <span>{internationalShipment.currentStatus}</span>
            </div>
            <div className="detail-line">
              <span>{t("operations.internationalCost")}</span>
              <span>{formatMoney(internationalShipment.internationalDeliveryCost)}</span>
            </div>
          </div>
        )}
        <form
          className="shipment-form"
          onSubmit={(event) => void registerInternationalShipment(event)}
        >
          <input
            defaultValue={internationalShipment?.providerName ?? ""}
            maxLength={160}
            name="providerName"
            placeholder={t("operations.provider")}
            required
          />
          <input
            defaultValue={internationalShipment?.providerReferenceNumber ?? ""}
            maxLength={80}
            name="providerReferenceNumber"
            placeholder={t("operations.providerReference")}
          />
          <input
            defaultValue={internationalShipment?.destinationCountryCode ?? "AE"}
            maxLength={2}
            minLength={2}
            name="destinationCountryCode"
            pattern="[A-Za-z]{2}"
            placeholder={t("operations.destinationCountry")}
            required
          />
          <input
            defaultValue={internationalShipment?.internationalDeliveryCost ?? "0"}
            min="0"
            name="internationalDeliveryCost"
            step="0.01"
            type="number"
          />
          <input
            defaultValue={internationalShipment?.customerCharge ?? "0"}
            min="0"
            name="customerCharge"
            step="0.01"
            type="number"
          />
          <input
            defaultValue={internationalShipment?.currentStatus ?? "created"}
            maxLength={80}
            name="currentStatus"
            placeholder={t("operations.status")}
            required
          />
          <input
            defaultValue={internationalShipment?.notes ?? ""}
            maxLength={300}
            name="notes"
            placeholder={t("operations.notes")}
          />
          <button
            className="button button-secondary button-compact"
            disabled={savingShipment}
            type="submit"
          >
            {savingShipment ? t("common.working") : t("operations.saveShipment")}
          </button>
        </form>
        {shipmentError === undefined ? null : <p className="form-error">{shipmentError}</p>}
      </section>
    </div>
  );
}

export function OrderBarcode({ value }: { value: string }) {
  const barcode = code128Barcode(value);
  return (
    <svg
      aria-label={value}
      className="barcode"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${barcode.width} 72`}
    >
      <rect fill="#fff" height="72" width={barcode.width} x="0" y="0" />
      {barcode.bars.map((bar) => (
        <rect
          fill="#111"
          height="58"
          key={`${bar.x}-${bar.width}`}
          width={bar.width}
          x={bar.x}
          y="4"
        />
      ))}
    </svg>
  );
}

function code128Barcode(value: string): {
  readonly bars: readonly { readonly width: number; readonly x: number }[];
  readonly width: number;
} {
  const sanitized = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 126 ? code - 32 : 31;
  });
  const codes = [104, ...sanitized];
  const checksum =
    codes.reduce((total, code, index) => total + (index === 0 ? code : code * index), 0) % 103;
  const patterns = [...codes, checksum, 106].map((code) => code128Patterns[code] ?? "111323");
  const bars: { width: number; x: number }[] = [];
  let x = 0;
  for (const pattern of patterns) {
    let black = true;
    for (const digit of pattern) {
      const width = Number.parseInt(digit, 10);
      if (black) {
        bars.push({ width, x });
      }
      x += width;
      black = !black;
    }
  }
  return { bars, width: x };
}

function barcodeSvg(value: string): string {
  const barcode = code128Barcode(value);
  const bars = barcode.bars
    .map((bar) => `<rect x="${bar.x}" y="4" width="${bar.width}" height="58" fill="#111"/>`)
    .join("");
  return `<svg class="waybill-barcode" role="img" aria-label="${escapeHtml(value)}" viewBox="0 0 ${barcode.width} 72" preserveAspectRatio="none"><rect x="0" y="0" width="${barcode.width}" height="72" fill="#fff"/>${bars}</svg>`;
}

export function openOrderWaybill(
  detail: OperationsOrderDetail,
  locale: "ar" | "en",
  labels: {
    readonly address: string;
    readonly amountDue: string;
    readonly barcode: string;
    readonly customer: string;
    readonly order: string;
    readonly printTitle: string;
    readonly serviceFee: string;
    readonly trader: string;
  },
) {
  const printWindow = window.open("", "_blank", "width=880,height=720");
  if (printWindow === null) {
    return;
  }
  const direction = locale === "ar" ? "rtl" : "ltr";
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="${locale}" dir="${direction}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(labels.printTitle)} ${escapeHtml(detail.orderNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #172126; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }
    .waybill { width: 190mm; min-height: 130mm; margin: 12mm auto; padding: 10mm; border: 1px solid #111; }
    .waybill-header { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8mm; }
    h1 { margin: 0; font-size: 26px; letter-spacing: 0; }
    .brand { font-size: 18px; font-weight: 800; }
    .number { font-size: 24px; font-weight: 800; }
    .waybill-barcode { width: 100%; height: 28mm; margin: 8mm 0 3mm; }
    .barcode-text { text-align: center; font-size: 18px; font-weight: 800; letter-spacing: 2px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-top: 8mm; }
    .field { min-height: 19mm; border: 1px solid #9aa9ae; padding: 4mm; }
    .field span { display: block; color: #52666d; font-size: 11px; font-weight: 800; text-transform: uppercase; }
    .field strong { display: block; margin-top: 2mm; font-size: 17px; overflow-wrap: anywhere; }
    .wide { grid-column: 1 / -1; min-height: 25mm; }
    @media print { body { margin: 0; } .waybill { margin: 0; border-color: #111; page-break-after: always; } }
  </style>
</head>
<body>
  <main class="waybill">
    <section class="waybill-header">
      <div>
        <div class="brand">BluelineGPT</div>
        <h1>${escapeHtml(labels.printTitle)}</h1>
      </div>
      <div class="number">${escapeHtml(detail.orderNumber)}</div>
    </section>
    ${barcodeSvg(detail.orderNumber)}
    <div class="barcode-text">${escapeHtml(detail.orderNumber)}</div>
    <section class="grid">
      <div class="field"><span>${escapeHtml(labels.order)}</span><strong>${escapeHtml(detail.orderNumber)}</strong></div>
      <div class="field"><span>${escapeHtml(labels.trader)}</span><strong>${escapeHtml(detail.traderName)}</strong></div>
      <div class="field"><span>${escapeHtml(labels.customer)}</span><strong>${escapeHtml(detail.customerName)}<br>${escapeHtml(detail.customerMobileNumber)}</strong></div>
      <div class="field"><span>${escapeHtml(labels.amountDue)}</span><strong>${escapeHtml(formatMoney(detail.customerAmountDue))}</strong></div>
      <div class="field wide"><span>${escapeHtml(labels.address)}</span><strong>${escapeHtml(detail.customerAddress)}</strong></div>
      <div class="field"><span>${escapeHtml(labels.serviceFee)}</span><strong>${escapeHtml(formatMoney(detail.serviceFee))}</strong></div>
      <div class="field"><span>${escapeHtml(labels.barcode)}</span><strong>${escapeHtml(detail.orderNumber)}</strong></div>
    </section>
  </main>
</body>
</html>`);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 150);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function nextOrderActions(
  status: string,
): readonly { readonly label: string; readonly status: string }[] {
  if (status === "new") {
    return [{ label: "cancel", status: "cancelled" }];
  }
  if (status === "assigned_to_driver" || status === "out_for_delivery") {
    return [{ label: "cancel", status: "cancelled" }];
  }
  if (status === "returned_to_branch") {
    return [{ label: "markReturned", status: "returned_to_trader" }];
  }
  return [];
}

const emptyReconciliationFilters = {
  dateFrom: "",
  dateTo: "",
  driverId: "",
  paymentMethod: "",
  search: "",
  status: "",
};

/**
 * Searchable, server-side Driver filter.
 *
 * Results come from the reconciliation Driver search API a page at a time; the
 * full Driver list is never downloaded into the browser.
 */
function ReconciliationDriverFilter({
  api,
  onChange,
  value,
}: {
  api: ApiClient;
  onChange: (driverId: string) => void;
  value: string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [drivers, setDrivers] = useState<readonly { id: string; code: string; name: string }[]>([]);
  useEffect(() => {
    const parameters = new URLSearchParams({ pageSize: "25" });
    if (search.trim() !== "") parameters.set("search", search.trim());
    let active = true;
    api
      .get<PagedResponse<{ id: string; code: string; name: string }>>(
        `operations/cash/drivers?${parameters.toString()}`,
      )
      .then((page) => active && setDrivers(page.items))
      .catch(() => active && setDrivers([]));
    return () => {
      active = false;
    };
  }, [api, search]);
  return (
    <>
      <label>
        <span className="sr-only">{t("operations.searchDrivers")}</span>
        <input
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("operations.searchDrivers")}
          type="search"
          value={search}
        />
      </label>
      <label>
        {t("operations.driver")}
        <select onChange={(event) => onChange(event.target.value)} value={value}>
          <option value="">{t("operations.all")}</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.code} — {driver.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function CashTable({
  api,
  // TODO: no endpoint exposes the Company name after login; see the Stage 6
  // report. Until GET configuration/settings returns it, the report falls back
  // to the product name rather than displaying an invented Company identity.
  companyName = "BluelineGPT",
  onNavigate,
  orders,
}: {
  api: ApiClient;
  companyName?: string;
  onNavigate: (path: string) => void;
  orders: readonly OperationsPendingCashOrder[];
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<OperationsDriverReconciliationDetail>();
  const [detailId, setDetailId] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  // The reconciliation list is server-paginated; this component owns its own
  // page, size and search so the parent does not refetch the whole workspace.
  const [reconciliationPage, setReconciliationPage] =
    useState<PagedResponse<OperationsDriverReconciliation> | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<ReconciliationPageSize>(25);
  const [listError, setListError] = useState<string>();
  const [filters, setFilters] = useState(emptyReconciliationFilters);
  const filtersApplied =
    Object.values(filters).some((value) => value.trim() !== "") || pageSize !== 25;
  // Every filter is server-side; changing any of them returns to page 1 so the
  // operator never lands on an out-of-range page.
  const applyFilter = (change: Partial<typeof emptyReconciliationFilters>) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...change }));
  };
  const clearFilters = () => {
    setPage(1);
    setPageSize(25);
    setFilters(emptyReconciliationFilters);
  };
  useEffect(() => {
    const parameters = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    for (const [key, value] of Object.entries(filters)) {
      if (value.trim() !== "") parameters.set(key, value.trim());
    }
    setListError(undefined);
    api
      .get<PagedResponse<OperationsDriverReconciliation>>(
        `operations/cash/reconciliations?${parameters.toString()}`,
      )
      .then(setReconciliationPage)
      .catch(() => setListError(t("operations.detailLoadFailed")));
  }, [api, filters, page, pageSize, t]);
  const reconciliations = reconciliationPage?.items ?? [];
  const total = reconciliationPage?.total ?? 0;
  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  const toggleDetail = async (reconciliation: OperationsDriverReconciliation) => {
    if (detailId === reconciliation.id) {
      setDetail(undefined);
      setDetailId(undefined);
      return;
    }
    setDetailError(undefined);
    try {
      const loaded = await api.get<OperationsDriverReconciliationDetail>(
        `operations/cash/reconciliations/${reconciliation.id}`,
      );
      setDetail(loaded);
      setDetailId(reconciliation.id);
    } catch {
      setDetailError(t("operations.detailLoadFailed"));
    }
  };
  return (
    <div className="stacked-tables">
      <section>
        <h2>{t("operations.pendingCash")}</h2>
        <table>
          <thead>
            <tr>
              <th>{t("operations.order")}</th>
              <th>{t("operations.driver")}</th>
              <th>{t("operations.customer")}</th>
              <th>{t("operations.amount")}</th>
              <th>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <strong>{order.orderNumber}</strong>
                </td>
                <td>{order.assignedDriverName}</td>
                <td>{order.customerName}</td>
                <td>
                  {formatMoney(order.amountCollected)}
                  <CashBreakdown order={order} />
                </td>
                <td>
                  <DriverCashStatusLabel value="pending" />
                </td>
              </tr>
            ))}
            {orders.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={5}>
                  {t("operations.noPendingCash")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      <section>
        <div className="section-header">
          <h2>{t("operations.recentReconciliations")}</h2>
          <button
            className="button button-primary no-print"
            onClick={() => onNavigate("/operations/driver-reconciliations/new")}
            type="button"
          >
            {t("operations.newReconciliation")}
          </button>
        </div>
        <div className="table-toolbar no-print">
          <label>
            <span className="sr-only">{t("operations.searchReconciliations")}</span>
            <input
              onChange={(event) => applyFilter({ search: event.target.value })}
              placeholder={t("operations.searchReconciliations")}
              type="search"
              value={filters.search}
            />
          </label>
          <ReconciliationDriverFilter
            api={api}
            onChange={(driverId) => applyFilter({ driverId })}
            value={filters.driverId}
          />
          <label>
            {t("operations.dateFrom")}
            <input
              onChange={(event) => applyFilter({ dateFrom: event.target.value })}
              type="date"
              value={filters.dateFrom}
            />
          </label>
          <label>
            {t("operations.dateTo")}
            <input
              onChange={(event) => applyFilter({ dateTo: event.target.value })}
              type="date"
              value={filters.dateTo}
            />
          </label>
          <label>
            {t("operations.status")}
            <select
              onChange={(event) => applyFilter({ status: event.target.value })}
              value={filters.status}
            >
              <option value="">{t("operations.all")}</option>
              <option value="confirmed">{t("operations.statusConfirmed")}</option>
              <option value="draft">{t("operations.statusDraft")}</option>
            </select>
          </label>
          <label>
            {t("operations.paymentMethod")}
            <select
              onChange={(event) => applyFilter({ paymentMethod: event.target.value })}
              value={filters.paymentMethod}
            >
              <option value="">{t("operations.all")}</option>
              <option value="cash">{t("operations.cash")}</option>
              <option value="bank_transfer">{t("operations.bankTransfer")}</option>
            </select>
          </label>
          <label>
            {t("operations.pageSize")}
            <select
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value) as ReconciliationPageSize);
              }}
              value={pageSize}
            >
              {reconciliationPageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!filtersApplied} onClick={clearFilters} type="button">
            {t("operations.clearFilters")}
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t("operations.reconciliation")}</th>
              <th>{t("operations.driver")}</th>
              <th>{t("operations.businessDate")}</th>
              <th>{t("operations.orders")}</th>
              <th>{t("operations.grossCollections")}</th>
              <th>{t("operations.netReceived")}</th>
              <th>{t("operations.status")}</th>
            </tr>
          </thead>
          <tbody>
            {reconciliations.map((reconciliation) => (
              <Fragment key={reconciliation.id}>
                <tr>
                  <td>
                    <strong>{reconciliation.reconciliationNumber}</strong>
                  </td>
                  <td>{reconciliation.driverName}</td>
                  <td>{reconciliation.businessDate}</td>
                  <td>{reconciliation.orderCount}</td>
                  <td>{formatMoney(reconciliation.grossCollections)}</td>
                  <td>{formatMoney(reconciliation.netAmountReceived)}</td>
                  <td>
                    <span>{reconciliation.statusLabel}</span>
                    <div className="row-actions row-actions-inline">
                      <button onClick={() => void toggleDetail(reconciliation)} type="button">
                        {detailId === reconciliation.id
                          ? t("operations.hideDetails")
                          : t("operations.viewDetails")}
                      </button>
                    </div>
                  </td>
                </tr>
                {detailId === reconciliation.id && detail !== undefined ? (
                  <tr>
                    <td className="detail-cell" colSpan={7}>
                      <ReconciliationDetail companyName={companyName} detail={detail} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
            {reconciliations.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={7}>
                  {filtersApplied
                    ? t("operations.noReconciliationMatches")
                    : t("operations.noReconciliations")}
                </td>
              </tr>
            ) : null}
            {listError === undefined ? null : (
              <tr>
                <td className="empty-state" colSpan={7}>
                  {listError}
                </td>
              </tr>
            )}
            {detailError === undefined ? null : (
              <tr>
                <td className="empty-state" colSpan={7}>
                  {detailError}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <nav aria-label={t("common.pagination")} className="pagination">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} type="button">
            {t("common.previous")}
          </button>
          <span>
            {t("common.pageOf", { page, pageCount })} ({t("common.totalRows", { total })})
          </span>
          <button disabled={page >= pageCount} onClick={() => setPage(page + 1)} type="button">
            {t("common.next")}
          </button>
        </nav>
      </section>
    </div>
  );
}

function ReconciliationDetail({
  companyName,
  detail,
}: {
  companyName: string;
  detail: OperationsDriverReconciliationDetail;
}) {
  const { t } = useTranslation();
  const { overview } = detail;
  return (
    <>
      {/* Rendered into a body-level portal; visible only when printing. */}
      <ReconciliationPrintReport companyName={companyName} detail={detail} />
    <div className="detail-grid reconciliation-detail">
      <section>
        <h3>{t("operations.overview")}</h3>
        <div className="detail-line">
          <span>{t("operations.reconciliation")}</span>
          <strong>{overview.reconciliationNumber}</strong>
        </div>
        <div className="detail-line">
          <span>{t("operations.businessDate")}</span>
          <span>{overview.businessDate}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.status")}</span>
          <span>{overview.statusLabel}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.confirmedBy")}</span>
          <span>
            {overview.confirmedBy} {overview.confirmedAt ?? ""}
          </span>
        </div>
      </section>
      <section>
        <h3>{t("operations.driver")}</h3>
        <div className="detail-line">
          <span>{overview.driverName}</span>
          <span>{t(`drivers.type.${overview.driverType}`, overview.driverType)}</span>
        </div>
      </section>
      <section>
        <h3>{t("operations.financialSummary")}</h3>
        <div className="detail-line">
          <span>{t("operations.selectedCollections")}</span>
          <span>{formatMoney(overview.grossCollections)}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.driverPayableDeduction")}</span>
          <span>{formatMoney("0.00")}</span>
        </div>
        <div className="detail-line">
          <span>{t("operations.expenses")}</span>
          <span>{formatMoney(overview.expenseTotal)}</span>
        </div>
        <div className="detail-line detail-line-total">
          <span>{t("operations.netExpected")}</span>
          <strong>{formatMoney(overview.netAmountReceived)}</strong>
        </div>
        <div className="detail-line">
          <span>{t("operations.paymentTotal")}</span>
          <span>{formatMoney(overview.paymentTotal)}</span>
        </div>
      </section>
      <section>
        <h3>{t("operations.orders")}</h3>
        {detail.orders.map((order) => (
          <div className="detail-line" key={order.id}>
            <span>
              <strong>{order.orderNumber}</strong> {order.customerName}
              <span className="cell-secondary">{order.cashStatusLabel}</span>
            </span>
            <span>{formatMoney(order.amountCollected)}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>{t("operations.payments")}</h3>
        {detail.payments.map((payment) => (
          <div className="detail-line" key={payment.id}>
            <span>
              {payment.paymentMethodLabel}
              <span className="cell-secondary">
                {[payment.bankName, payment.bankAccountName, payment.bankReference]
                  .filter((value) => value !== null && value !== "")
                  .join(" | ")}
                {payment.recordedBy === "" ? "" : ` | ${payment.recordedBy}`}
              </span>
            </span>
            <span>{formatMoney(payment.amount)}</span>
          </div>
        ))}
        {detail.payments.length === 0 ? (
          <p className="empty-state">{t("operations.noPayments")}</p>
        ) : null}
      </section>
      <section>
        <h3>{t("operations.expenses")}</h3>
        {detail.expenses.map((expense) => (
          <div className="detail-line" key={expense.id}>
            <span>
              {expense.expenseType}
              <span className="cell-secondary">
                {[expense.description, expense.reference, expense.recordedBy]
                  .filter((value) => value !== null && value !== "")
                  .join(" | ")}
              </span>
            </span>
            <span>{formatMoney(expense.amount)}</span>
          </div>
        ))}
        {detail.expenses.length === 0 ? (
          <p className="empty-state">{t("operations.noExpenses")}</p>
        ) : null}
      </section>
      <section>
        <h3>{t("operations.historyAudit")}</h3>
        {detail.audit.map((entry, index) => (
          <div className="detail-line" key={`${entry.action}-${index}`}>
            <span>{entry.action}</span>
            <span>
              {entry.actor} {entry.occurredAt}
            </span>
          </div>
        ))}
        {detail.audit.length === 0 ? (
          <p className="empty-state">{t("operations.noAuditHistory")}</p>
        ) : null}
      </section>
      <div className="row-actions no-print">
        <button onClick={() => globalThis.print()} type="button">
          {t("common.print")}
        </button>
      </div>
      </div>
    </>
  );
}

function CashBreakdown({
  order,
}: {
  order: {
    readonly codAmount: string;
    readonly customerAmountDue: string;
    readonly serviceFee: string;
    readonly vatAmount: string;
  };
}) {
  const { t } = useTranslation();
  return (
    <span className="cell-secondary">
      {t("operations.cod")}: {formatMoney(order.codAmount)} | {t("operations.serviceFee")}:{" "}
      {formatMoney(order.serviceFee)} | {t("operations.vatAmount")}: {formatMoney(order.vatAmount)}{" "}
      | {t("operations.customerAmountDue")}: {formatMoney(order.customerAmountDue)}
    </span>
  );
}

function DriversTable({ drivers }: { drivers: readonly OperationsDriver[] }) {
  const { t } = useTranslation();
  return (
    <table>
      <thead>
        <tr>
          <th>{t("operations.driver")}</th>
          <th>{t("operations.type")}</th>
          <th>{t("operations.status")}</th>
          <th>{t("operations.activeOrders")}</th>
          <th>{t("operations.delivered")}</th>
          <th>{t("operations.pendingCash")}</th>
        </tr>
      </thead>
      <tbody>
        {drivers.map((driver) => (
          <tr key={driver.id}>
            <td>
              <strong>{driver.name}</strong>
              <span className="cell-secondary">
                {driver.code} · {driver.mobileNumber}
              </span>
            </td>
            <td>{t(`statuses.${driver.type}`)}</td>
            <td>
              <span className={`status status-${driver.status}`}>
                {t(`statuses.${driver.status}`)}
              </span>
            </td>
            <td>{driver.activeOrders}</td>
            <td>{driver.deliveredOrders}</td>
            <td>{driver.pendingCashOrders}</td>
          </tr>
        ))}
        {drivers.length === 0 ? (
          <tr>
            <td className="empty-state" colSpan={6}>
              {t("operations.noDrivers")}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function formatMoney(value: string | undefined): string {
  return Number(value ?? 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

export function LegacyCreateOrderDialog({
  api,
  areas,
  drivers,
  onClose,
  onSaved,
  traders,
}: {
  api: ApiClient;
  areas: readonly CompanyArea[];
  drivers: readonly OperationsDriver[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  traders: readonly OperationsTrader[];
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError(undefined);
    try {
      await api.post<OperationsOrder>("operations/orders", {
        areaId: String(form.get("areaId") ?? ""),
        codAmount: Number(form.get("codAmount") ?? 0),
        customerAddress: String(form.get("customerAddress") ?? ""),
        customerMobileNumber: String(form.get("customerMobileNumber") ?? ""),
        customerName: String(form.get("customerName") ?? ""),
        driverId: optionalString(form.get("driverId")),
        packageCount: Number(form.get("packageCount") ?? 1),
        serviceFee: Number(form.get("serviceFee") ?? 0),
        traderId: String(form.get("traderId") ?? ""),
      });
      await onSaved();
    } catch {
      setError(t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="create-order-title"
        aria-modal="true"
        className="modal modal-small"
        role="dialog"
      >
        <div className="modal-heading">
          <h2 id="create-order-title">{t("operations.createOrder")}</h2>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <label className="field">
            <span>{t("operations.trader")}</span>
            <select name="traderId" required>
              {traders.map((trader) => (
                <option key={trader.id} value={trader.id}>
                  {trader.code} - {trader.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("operations.areaField")}</span>
            <select name="areaId" required>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.code} - {area.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("operations.driver")}</span>
            <select name="driverId">
              <option value="">{t("operations.unassigned")}</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.code} - {driver.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("operations.customer")}</span>
            <input maxLength={160} name="customerName" required />
          </label>
          <label className="field">
            <span>{t("operations.mobile")}</span>
            <input maxLength={32} name="customerMobileNumber" required />
          </label>
          <label className="field">
            <span>{t("operations.customerAddress")}</span>
            <textarea maxLength={500} name="customerAddress" required rows={3} />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>{t("operations.cod")}</span>
              <input
                defaultValue="100"
                min="0"
                name="codAmount"
                required
                step="0.01"
                type="number"
              />
            </label>
            <label className="field">
              <span>{t("operations.serviceFee")}</span>
              <input
                defaultValue="10"
                min="0"
                name="serviceFee"
                required
                step="0.01"
                type="number"
              />
            </label>
          </div>
          <label className="field">
            <span>{t("operations.packages")}</span>
            <input defaultValue="1" min="1" name="packageCount" required step="1" type="number" />
          </label>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.working") : t("common.save")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ImportOrdersDialog({
  api,
  onClose,
  onImported,
}: {
  api: ApiClient;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [csv, setCsv] = useState(
    "traderId,areaId,driverId,customerName,customerMobileNumber,customerAddress,codAmount,serviceFee,packageCount\n",
  );
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OperationsOrderImportResult>();
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await api.post<OperationsOrderImportResult>("operations/orders/import-csv", {
        csv,
      });
      setResult(response);
      if (response.importedRows > 0) await onImported();
    } catch {
      setError(t("operations.importFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="import-orders-title"
        aria-modal="true"
        className="modal"
        role="dialog"
      >
        <div className="modal-heading">
          <h2 id="import-orders-title">{t("operations.importOrders")}</h2>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <label className="field">
            <span>{t("operations.csvRows")}</span>
            <textarea
              onChange={(event) => setCsv(event.target.value)}
              required
              rows={10}
              value={csv}
            />
          </label>
          {result === undefined ? null : (
            <div className={result.errors.length > 0 ? "alert alert-error" : "alert alert-info"}>
              <strong>
                {result.importNumber.length > 0
                  ? `${result.importNumber}: ${result.importedRows}/${result.totalRows}`
                  : `${result.importedRows}/${result.totalRows}`}
              </strong>
              {result.errors.map((item) => (
                <span className="cell-secondary" key={item}>
                  {item}
                </span>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.working") : t("operations.importOrders")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

function operationsOrdersPath(filters: OrderFilters): string {
  const query = operationsOrdersQuery(filters);
  return query.length > 0 ? `operations/orders?${query}` : "operations/orders";
}

function operationsOrdersExportPath(filters: OrderFilters): string {
  const query = operationsOrdersQuery(filters);
  return query.length > 0
    ? `operations/reports/orders-export?${query}`
    : "operations/reports/orders-export";
}

function operationsOrdersQuery(filters: OrderFilters): string {
  const parameters = new URLSearchParams();
  if (filters.areaId.length > 0) parameters.set("areaId", filters.areaId);
  if (filters.search.trim().length > 0) parameters.set("search", filters.search.trim());
  if (filters.deliveryStatus.length > 0) parameters.set("deliveryStatus", filters.deliveryStatus);
  if (filters.cashStatus.length > 0) parameters.set("cashStatus", filters.cashStatus);
  if (filters.dateFrom.length > 0) parameters.set("dateFrom", filters.dateFrom);
  if (filters.dateTo.length > 0) parameters.set("dateTo", filters.dateTo);
  if (filters.driverId.length > 0) parameters.set("driverId", filters.driverId);
  if (filters.settlementStatus.length > 0) {
    parameters.set("settlementStatus", filters.settlementStatus);
  }
  if (filters.traderId.length > 0) parameters.set("traderId", filters.traderId);
  return parameters.toString();
}

function downloadTextFile(filename: string, content: string, contentType: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
