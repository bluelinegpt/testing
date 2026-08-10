import {
  ArrowLeft,
  Banknote,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  HandCoins,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Truck,
  UserRoundCheck,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type {
  CompanyArea,
  Emirate,
  CustomerOption,
  OperationsDriver,
  OperationsOrder,
  OperationsOrderQuote,
  OperationsOrderDetail,
  OperationsOrderPage,
  OperationsTrader,
  OperationsTraderOption,
  OperationsTrackingLink,
  SearchPage,
} from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { StickyHorizontalScrollbar } from "../../components/StickyHorizontalScrollbar.js";
import {
  useWorkflowDeepLink,
  type WorkflowDeepLink,
  type WorkflowDialog,
} from "./use-workflow-deep-link.js";
import { PageHeader } from "../../components/PageHeader.js";
import { FilterCombobox } from "../../components/FilterCombobox.js";
import { SearchCombobox } from "../../components/SearchCombobox.js";
import { isUaeMobile, normalizeUaeMobile } from "../../domain/uae-mobile.js";
import { formatCurrency, formatDate, formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { CompanyBrandingContext } from "../../app/CompanyBrandingContext.js";
import { AccountingRelatedPanel } from "../accounting/AccountingRelatedPanel.js";
import { localizeName } from "../../localization/localize-name.js";
import { formatMoneyValue, parseMoneyInput, parseNumericInput } from "../../utils/numeric-input.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { useListState } from "../accounting/use-list-state.js";
import { BusinessDateFilterControls } from "./BusinessDateFilterControls.js";
import {
  orderAccountingStatus,
  orderFeeSource,
  showsAccountingRelatedRecords,
} from "./order-accounting-policy.js";
import { CreateOrderDialog } from "./CreateOrderDialog.js";
import { DriverCashStatusLabel, useDriverCashStatusLabel } from "./DriverCashStatus.js";
import { OrderWorkflowIndicator } from "./OrderWorkflowIndicator.js";
import { DriverCollectionDetailDialog } from "./DriverCollectionsWorkspace.js";
import { openOrderWaybill, OrderBarcode } from "./OperationsWorkspace.js";
import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";
import { SettlementDetailDialog } from "./TraderSettlementsWorkspace.js";
import { materialFingerprint, useIdempotencyKey } from "./useIdempotencyKey.js";

/**
 * `delivery` is a FRONTEND-ONLY view. It is never sent as `quickView`: the
 * backend expresses Delivery Activity through `deliveredOnly`, and sending an
 * unrecognised quick view would silently fall through to the Active predicate.
 */
type QuickView = "active" | "all" | "hold" | "cancelled" | "closed" | "delivery";

/** Quick views the backend actually understands. */
const backendQuickViews = new Set(["active", "all", "hold", "cancelled", "closed"]);
type OrderGrouping = "" | "status" | "driver";
type BulkAction = "assign" | "collect" | "manifest" | "status";

interface OrderFilters {
  areaId: string;
  cashStatus: string;
  /* Selecting an Emirate used to narrow only the Area picker and filter
     nothing, so "show me every Order in Sharjah" was impossible without
     choosing each Area in turn. It is a real server-side filter now. */
  emirateId: string;
  dateFrom: string;
  dateTo: string;
  deliveryStatus: string;
  driverId: string;
  quickView: QuickView;
  // Delivery Activity. Empty in every other view, so `filterQuery` omits them
  // and no other quick view can be affected by a stale value.
  deliveredOnly: string;
  deliveryDateFrom: string;
  deliveryDateTo: string;
  dateMode: string;
  businessDateFrom: string;
  businessDateTo: string;
  referenceNumber: string;
  search: string;
  settlementStatus: string;
  traderId: string;
}

interface SelectionPayload extends OrderFilters {
  excludedOrderIds?: readonly string[];
  orderIds?: readonly string[];
  selectionMode: "filter" | "ids";
}

const manifestFilterKeys = [
  "areaId",
  "cashStatus",
  "dateFrom",
  "dateTo",
  "deliveryStatus",
  "driverId",
  "quickView",
  "search",
  "settlementStatus",
  "traderId",
] as const satisfies readonly (keyof OrderFilters)[];

type ManifestSelectionPayload = Partial<OrderFilters> & {
  excludedOrderIds?: readonly string[];
  orderIds?: readonly string[];
  selectionMode: "filter" | "ids";
};

function manifestSelectionPayload(
  filters: OrderFilters,
  allMatching: boolean,
  excludedIds: Set<string>,
  selectedIds: Set<string>,
): ManifestSelectionPayload {
  if (!allMatching) {
    return {
      orderIds: [...selectedIds],
      selectionMode: "ids",
    };
  }
  const payload: ManifestSelectionPayload = {
    excludedOrderIds: [...excludedIds],
    selectionMode: "filter",
  };
  for (const key of manifestFilterKeys) {
    if (filters[key] !== "") Object.assign(payload, { [key]: filters[key] });
  }
  return payload;
}

interface SelectionSummary {
  eligibleCount: number;
  ineligible: readonly { orderNumber: string; reason: string }[];
  selectedAmountToCollect: string;
  selectedCount: number;
}

const initialFilters: OrderFilters = {
  areaId: "",
  cashStatus: "",
  emirateId: "",
  dateFrom: "",
  dateTo: "",
  deliveryStatus: "",
  driverId: "",
  quickView: "active",
  deliveredOnly: "",
  deliveryDateFrom: "",
  deliveryDateTo: "",
  dateMode: "",
  businessDateFrom: "",
  businessDateTo: "",
  referenceNumber: "",
  search: "",
  settlementStatus: "",
  traderId: "",
};

/**
 * Filter names this screen puts in the URL.
 *
 * Module-level and built once: `useListState` memoizes on this array, so a
 * literal created during render would produce new state every render and
 * re-fire the request effect forever.
 */
const orderFilterKeys = Object.keys(initialFilters);

export function OrdersModuleWorkspace({
  api,
  onNavigate,
  permissions,
}: {
  api: ApiClient;
  onNavigate: (path: string) => void;
  permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  // Business-data display follows the user's Search-and-Display preference,
  // falling back to the UI language when no branding provider is present.
  const branding = useContext(CompanyBrandingContext);
  const textLanguage = branding?.textLanguage ?? locale;
  /* The Orders table scroll container. The sticky horizontal scrollbar mirrors
     this element rather than owning a scroll position of its own. */
  const ordersScrollRef = useRef<HTMLDivElement>(null);
  /* A smart next action from the workflow popover can ask this screen to open
     a row's Change Status or Assign Driver dialog. Parsed by the shared
     primitive, which strips `openDialog` so a refresh cannot reopen it. The
     request is matched against the LOADED page, so an Order from another
     Company simply never matches: the list is Company-scoped by the API. */
  const orderDeepLink = useWorkflowDeepLink(orderDialogs);
  /* The request already acted on, held by IDENTITY rather than as a boolean.
     The hook builds one object per distinct request, so comparing identity
     retires exactly that request and lets a genuinely new one through. A sticky
     boolean would have swallowed every later next-step click on this screen. */
  const [consumedDeepLink, setConsumedDeepLink] = useState<WorkflowDeepLink | null>(null);
  const [orderActionNotice, setOrderActionNotice] = useState<string>();
  // The URL is the authoritative Orders list state. No parallel local or
  // session copy of these fields remains to drift out of step with it.
  //
  // `quickView` is persisted under its own name — including `delivery`, which
  // stays frontend-only. The request builder decides separately whether the
  // value is one the backend understands, so a URL parameter and an API
  // parameter that happen to share a name never have to mean the same thing.
  const session = useSessionAccess();
  const list = useListState({
    companyId: session?.companyId,
    defaultSortBy: "orderDate",
    filterKeys: orderFilterKeys,
  });
  const { page } = list;
  const pageSize = list.pageSize;
  const setPage = list.setPage;
  const setPageSize = list.setPageSize;
  // `useListState` omits empty filters and stores everything as text; the panel
  // and the request builder expect every key present.
  const filters = useMemo<OrderFilters>(
    () => ({ ...initialFilters, ...list.filters }) as OrderFilters,
    [list.filters],
  );
  const setFilters = (update: (current: OrderFilters) => OrderFilters) =>
    list.setFilters(update(filters) as unknown as Record<string, string>);
  const [data, setData] = useState<OperationsOrderPage>();
  const [holdCount, setHoldCount] = useState(0);
  const [emirates, setEmirates] = useState<readonly Emirate[]>([]);
  const [filterEmirateId, setFilterEmirateId] = useState("");
  /* The search box types into local state and reaches the filter -- and so the
     request -- only on Enter. Searching per keystroke sent one request per
     character against a 100-per-minute limit and returned
     `ThrottlerException: Too Many Requests`; a debounce reduced that but still
     fired searches nobody asked for, on half-typed terms. Enter makes the
     search an explicit act. */
  const [searchText, setSearchText] = useState("");
  const [filterArea, setFilterArea] = useState<CompanyArea>();
  const [drivers, setDrivers] = useState<readonly OperationsDriver[]>([]);
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<OrderGrouping>("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<SelectionSummary>();
  const [bulkAction, setBulkAction] = useState<BulkAction>();
  const [createOpen, setCreateOpen] = useState(false);
  const [fastEntryOpen, setFastEntryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const query = useMemo(() => {
    const parameters = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    // Delivery Activity is carried by `deliveredOnly`, never by `quickView`.
    // Sending an unknown quick view would fall through to the Active predicate
    // and quietly return the wrong Orders.
    if (backendQuickViews.has(filters.quickView)) {
      parameters.set("quickView", filters.quickView);
    }
    for (const [key, value] of Object.entries(filters)) {
      if (key !== "quickView" && value !== "") parameters.set(key, value);
    }
    return parameters.toString();
  }, [filters, page, pageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      /* Only the Orders page depends on the filters. The Hold count, the Driver
         list and the Trader list are the same whatever is typed, so refetching
         them per keystroke quadrupled the request rate for no new data. They
         load once, below. */
      const orders = await api.get<OperationsOrderPage>(`operations/orders?${query}`);
      setData({
        ...orders,
        items: Array.isArray(orders.items) ? orders.items : [],
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, query, t]);

  useEffect(() => void load(), [load]);

  // Reference data that no filter changes: fetched once per mount rather than
  // with every list reload.
  useEffect(() => {
    let active = true;
    void (async () => {
      const [holdOrders, loadedDrivers, loadedTraders] = await Promise.all([
        api.get<OperationsOrderPage>("operations/orders?page=1&pageSize=25&quickView=hold"),
        api.get<readonly OperationsDriver[]>("operations/drivers"),
        api.get<readonly OperationsTrader[]>("operations/traders"),
      ]).catch(() => [undefined, undefined, undefined] as const);
      if (!active) return;
      if (holdOrders !== undefined) setHoldCount(holdOrders.filteredCount);
      if (loadedDrivers !== undefined) {
        setDrivers(loadedDrivers.filter((driver) => driver.status === "active"));
      }
      // Active only, exactly as before the split.
      if (loadedTraders !== undefined) {
        setTraders(loadedTraders.filter((trader) => trader.status === "active"));
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  // Emirates scope the Area filter; load them once.
  useEffect(() => {
    let active = true;
    void api
      .get<readonly Emirate[]>("configuration/emirates")
      .then((loaded) => active && setEmirates(Array.isArray(loaded) ? loaded : []))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);
  // Selection is cleared when the filters change, because a selected Order
  // may no longer be in the result set.
  //
  // The page reset that used to live here is GONE on purpose: `useListState`
  // already resets to page 1 on every filter write. Doing it again from an
  // effect would push a second history entry for one user action, and Back
  // would appear not to work.
  useEffect(() => {
    setSelectedIds(new Set());
    setExcludedIds(new Set());
    setAllMatching(false);
  }, [filters]);

  const selection = useMemo<SelectionPayload>(
    () => ({
      ...filters,
      ...(allMatching
        ? { excludedOrderIds: [...excludedIds], selectionMode: "filter" as const }
        : { orderIds: [...selectedIds], selectionMode: "ids" as const }),
    }),
    [allMatching, excludedIds, filters, selectedIds],
  );
  const manifestSelection = useMemo<ManifestSelectionPayload>(
    () => manifestSelectionPayload(filters, allMatching, excludedIds, selectedIds),
    [allMatching, excludedIds, filters, selectedIds],
  );
  const selectedCount = allMatching
    ? Math.max(0, (data?.filteredCount ?? 0) - excludedIds.size)
    : selectedIds.size;

  useEffect(() => {
    if (selectedCount === 0) {
      setSummary(undefined);
      return;
    }
    let active = true;
    void api
      .post<SelectionSummary>("operations/orders/selection-summary", selection)
      .then((result) => active && setSummary(result))
      .catch(() => active && setSummary(undefined));
    return () => {
      active = false;
    };
  }, [api, selectedCount, selection]);

  const updateFilters = (change: Partial<OrderFilters>) =>
    setFilters((current) => ({ ...current, ...change }));

  // Filter -> box: Clear filters, or arriving on a URL that already carries a
  // term. Guarded on inequality so it cannot fight the user's typing.
  useEffect(() => {
    setSearchText((current) => (current === filters.search ? current : filters.search));
  }, [filters.search]);

  /* Clearing the box applies at once. Waiting for Enter to reveal the full list
     again would leave the operator looking at filtered results with an empty
     search box, which reads as a bug. Only a non-empty term waits for Enter. */
  useEffect(() => {
    if (searchText === "" && filters.search !== "") updateFilters({ search: "" });
    // `updateFilters` is recreated every render and is not a real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, filters.search]);

  /**
   * Switch quick view, carrying Delivery Activity's own fields with it.
   *
   * One functional update, not several `updateFilters` calls: separate calls
   * would each start from the same stale snapshot and the later ones would
   * discard the earlier changes.
   *
   * Entering opens in a clean Calendar Date state; leaving clears every
   * Delivery Activity field so none of them can leak into Active, All, Hold,
   * Cancelled or Closed. Unrelated filters and page size are preserved.
   */
  /**
   * Date Mode and Delivery Activity date changes.
   *
   * One functional update plus a page reset — separate calls would each start
   * from the same stale snapshot and the later ones would discard the earlier
   * changes. The control already clears the fields of the mode being left, so
   * no stale value can travel into a request it does not belong in.
   */
  // Delivery Activity adds two columns. Derived once so every colspan below
  // moves with the header instead of being hardcoded in several places.
  const deliveryView = filters.quickView === "delivery";
  const deliveryColumns = deliveryView ? 2 : 0;

  const applyDeliveryFilter = (patch: Record<string, string>) => {
    list.setFilters(patch);
  };

  const selectQuickView = (view: QuickView) => {
    list.setFilters({
      quickView: view,
      businessDateFrom: "",
      businessDateTo: "",
      deliveryDateFrom: "",
      deliveryDateTo: "",
      ...(view === "delivery"
        ? { dateMode: "calendar_date", deliveredOnly: "true" }
        : { dateMode: "", deliveredOnly: "" }),
    });
  };
  const orderItems = Array.isArray(data?.items) ? data.items : [];
  const traderFilterOptions = Array.isArray(traders) ? traders : [];
  const driverFilterOptions = Array.isArray(drivers) ? drivers : [];
  const emirateFilterOptions = Array.isArray(emirates) ? emirates : [];
  const pageIds = orderItems.map((order) => order.id);
  const isAdministrator = permissions.includes("users_roles.manage");
  const canAssignDriver = isAdministrator || permissions.includes("orders.assign_driver");
  const canUpdateStatus = isAdministrator || permissions.includes("orders.update_delivery_status");
  const canReconcile = isAdministrator || permissions.includes("reconciliations.create");
  const canSettle = isAdministrator || permissions.includes("settlements.create");
  const canManifest =
    isAdministrator || permissions.includes("reports.export") || canAssignDriver || canUpdateStatus;
  const canSelectOrders = canAssignDriver || canUpdateStatus || canReconcile || canSettle;
  const pageSelected =
    pageIds.length > 0 &&
    pageIds.every((id) => (allMatching ? !excludedIds.has(id) : selectedIds.has(id)));
  const toggleOrder = (id: string) => {
    if (allMatching) {
      setExcludedIds((current) => toggleSet(current, id));
    } else {
      setSelectedIds((current) => toggleSet(current, id));
    }
  };
  const togglePage = () => {
    if (allMatching) {
      setExcludedIds((current) => updateSet(current, pageIds, pageSelected));
    } else {
      setSelectedIds((current) => updateSet(current, pageIds, pageSelected));
    }
  };
  const clearSelection = () => {
    setAllMatching(false);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
  };
  const orderSelected = (id: string) => (allMatching ? !excludedIds.has(id) : selectedIds.has(id));
  const groups = useMemo(
    () => groupVisibleOrders(orderItems, grouping, t),
    [orderItems, grouping, t],
  );
  const changeGrouping = (next: OrderGrouping) => {
    if (allMatching) {
      setSelectedIds(new Set(pageIds.filter((id) => !excludedIds.has(id))));
      setAllMatching(false);
      setExcludedIds(new Set());
    }
    setGrouping(next);
    setCollapsedGroups(new Set());
  };
  const toggleGroup = (groupIds: readonly string[]) => {
    const allSelected = groupIds.every((id) => orderSelected(id));
    setAllMatching(false);
    setExcludedIds(new Set());
    setSelectedIds((current) => updateSet(current, groupIds, allSelected));
  };
  const toggleCollapsedGroup = (key: string) =>
    setCollapsedGroups((current) => toggleSet(current, key));
  const renderOrderRow = (order: OperationsOrder) => {
    const checked = orderSelected(order.id);
    return (
      <tr key={order.id}>
        <td>
          {canSelectOrders ? (
            <input
              aria-label={t("operations.selectOrder", {
                order: order.serialNumber ?? t("operations.legacyIdentifier"),
              })}
              checked={checked}
              onChange={() => toggleOrder(order.id)}
              type="checkbox"
            />
          ) : null}
        </td>
        <td>
          <button
            className="order-number-link"
            onClick={() => onNavigate(`/orders/${encodeURIComponent(order.orderNumber)}`)}
            type="button"
          >
            {order.serialNumber ?? t("operations.legacyIdentifier")}
          </button>
          <span className="cell-secondary">{formatDate(order.orderDate, locale)}</span>
        </td>
        <td>{order.referenceNumber ?? t("operations.notProvided")}</td>
        <td>
          {order.traderName}
          <span className="cell-secondary">{order.areaName}</span>
        </td>
        <td>
          {order.customerName}
          <span className="cell-secondary">{order.customerMobileNumber}</span>
        </td>
        <td>
          {order.assignedDriverName ?? t("operations.unassigned")}
          {order.assignedDriverMobile === null ? null : (
            <span className="cell-secondary">{order.assignedDriverMobile}</span>
          )}
        </td>
        <td className="money-cell">{formatCurrency(order.codAmount, "AED", locale)}</td>
        <td className="money-cell">
          {formatCurrency(order.totalDeductions ?? "0", "AED", locale)}
        </td>
        <td className="money-cell">{formatCurrency(order.traderNetPayable, "AED", locale)}</td>
        <td className="money-cell">{formatCurrency(order.customerAmountDue, "AED", locale)}</td>
        <td>
          <DeliveryStatusBadge order={order} />
        </td>
        {!deliveryView ? null : (
          <>
            {/* Backend values only. No fallback to Order Date, Created At,
                Updated At or status history, and no Business Date arithmetic
                in the browser. */}
            <td dir="ltr" className="nowrap-cell">
              {order.deliveredAt == null
                ? t("operations.historicalDeliveryTimestampUnavailable")
                : formatDateTime(order.deliveredAt, locale)}
            </td>
            <td dir="ltr" className="nowrap-cell">
              {order.deliveryBusinessDate == null
                ? t("operations.historicalDeliveryTimestampUnavailable")
                : formatDate(order.deliveryBusinessDate, locale)}
            </td>
          </>
        )}
        <td>
          <OrderAccountingBadge order={order} />
        </td>
        <td>
          <FinancialStatusCell
            onNavigate={onNavigate}
            order={order}
            permissions={permissions}
          />
        </td>
        <td>
          <OrderRowActions
            api={api}
            drivers={drivers}
            onChanged={load}
            onWorkflowRequestIneligible={() =>
              setOrderActionNotice(t("operations.workflowActionIneligible"))
            }
            onWorkflowRequestConsumed={() => setConsumedDeepLink(orderDeepLink.link)}
            {...(orderDeepLink.link !== null &&
            orderDeepLink.link !== consumedDeepLink &&
            orderDeepLink.link.orderId === order.id
              ? // Passed through as the link OBJECT, not a fresh literal: a stable
                // identity is what lets the row tell a re-render from a new request.
                { workflowRequest: orderDeepLink.link }
              : {})}
            onNavigate={onNavigate}
            order={order}
            permissions={permissions}
          />
        </td>
      </tr>
    );
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            <button
              className="icon-button"
              onClick={() => void load()}
              title={t("common.refresh")}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={18} />
            </button>
            <button
              className="button button-primary"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              <Plus aria-hidden="true" size={18} /> {t("operations.createOrder")}
            </button>
            <button className="button" onClick={() => setFastEntryOpen(true)} type="button">
              {t("operations.fastEntry")}
            </button>
          </>
        }
        eyebrow={t("nav.orders")}
        title={t("operations.orders")}
      />
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <section className="orders-workspace">
        <div className="orders-quick-views" role="tablist" aria-label={t("operations.orderViews")}>
          {(["active", "hold", "all", "closed", "cancelled", "delivery"] as const).map((view) => (
            <button
              aria-selected={filters.quickView === view}
              className={filters.quickView === view ? "active" : undefined}
              key={view}
              onClick={() => selectQuickView(view)}
              role="tab"
              type="button"
            >
              {t(`operations.quickView.${view}`)}
              {view === "hold" ? <span className="tab-count">{holdCount}</span> : null}
            </button>
          ))}
        </div>
        {/* Delivery Activity only. The same shared control the three other
            activity screens use — a second Date Mode component would be a
            second opinion about where a business day begins. */}
        {filters.quickView !== "delivery" ? null : (
          <BusinessDateFilterControls
            applied={data?.appliedDateMode}
            authoritativeTimestampLabel={t("operations.deliveryDateTime")}
            businessDateFrom={filters.businessDateFrom}
            businessDateTo={filters.businessDateTo}
            calendarDateFrom={filters.deliveryDateFrom}
            calendarDateTo={filters.deliveryDateTo}
            calendarFromLabel={t("operations.deliveryDateFrom")}
            calendarKeyFrom="deliveryDateFrom"
            calendarKeyTo="deliveryDateTo"
            calendarToLabel={t("operations.deliveryDateTo")}
            dateMode={filters.dateMode}
            historicalWarningLabel={t("operations.historicalDeliveryExcluded")}
            onChange={applyDeliveryFilter}
          />
        )}
        <div className="orders-filter-bar">
          {/* One field for every identifier an operator has to hand. The
              separate Reference Number input that used to sit beside this was
              removed with the unified search: the backend now matches Order
              Number, Reference, Customer Name and Mobile from this single term,
              so a second box asked the operator to classify their own input and
              left the filter row visibly uneven. */}
          <label className="orders-search">
            <Search aria-hidden="true" size={17} />
            <span className="sr-only">{t("operations.searchOrders")}</span>
            <input
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // The box is not inside a form, but preventDefault keeps this
                // safe if it is ever moved into one.
                event.preventDefault();
                updateFilters({ search: searchText });
              }}
              placeholder={t("operations.searchOrdersPlaceholder")}
              value={searchText}
            />
          </label>
          {/* Name only, and searchable. The code stays matchable so anyone who
              knows "TRD-000002" can still type it, but it is not printed on
              every row where it only crowds out the name. */}
          <label className="filter-select filter-combobox-field">
            <span className="sr-only">{t("operations.trader")}</span>
            <FilterCombobox
              emptyText={t("operations.noTradersFound")}
              label={t("operations.trader")}
              onChange={(value) => updateFilters({ traderId: value })}
              options={traderFilterOptions.map((trader) => ({
                id: trader.id,
                label: trader.name,
                searchText: trader.code,
              }))}
              value={filters.traderId}
            />
          </label>
          <label className="filter-select filter-combobox-field">
            <span className="sr-only">{t("operations.driver")}</span>
            <FilterCombobox
              emptyText={t("operations.noDriversFound")}
              label={t("operations.driver")}
              onChange={(value) => updateFilters({ driverId: value })}
              options={driverFilterOptions.map((driver) => ({
                id: driver.id,
                label: driver.name,
                searchText: driver.code,
              }))}
              value={filters.driverId}
            />
          </label>
          <FilterSelect
            label={t("areas.emirate")}
            onChange={(value) => {
              setFilterEmirateId(value);
              setFilterArea(undefined);
              // Area is cleared because it belongs to the previous Emirate.
              updateFilters({ areaId: "", emirateId: value });
            }}
            value={filterEmirateId}
          >
            {emirateFilterOptions.map((emirate) => (
              <option key={emirate.id} value={emirate.id}>
                {localizeName(textLanguage, { ar: emirate.nameAr, en: emirate.nameEn })}
              </option>
            ))}
          </FilterSelect>
          <label className="filter-select filter-area">
            <span className="sr-only">{t("operations.areaField")}</span>
            {filterEmirateId === "" ? (
              <input disabled placeholder={t("areas.selectEmirateFirst")} readOnly value="" />
            ) : (
              <SearchCombobox<CompanyArea>
                api={api}
                emptyText={t("areas.noneFound")}
                getLabel={(area) =>
                  localizeName(textLanguage, { ar: area.nameAr, en: area.nameEn })
                }
                key={filterEmirateId}
                label={t("operations.areaField")}
                onChange={(area) => {
                  setFilterArea(area);
                  updateFilters({ areaId: area?.id ?? "" });
                }}
                path={`configuration/areas/search?emirateId=${encodeURIComponent(
                  filterEmirateId,
                )}&activeOnly=true`}
                placeholder={t("areas.searchPlaceholder")}
                value={filterArea}
              />
            )}
          </label>
          <FilterSelect
            label={t("operations.deliveryStatus")}
            onChange={(value) => updateFilters({ deliveryStatus: value })}
            value={filters.deliveryStatus}
          >
            {deliveryStatuses.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label={t("operations.driverCashStatus")}
            onChange={(value) => updateFilters({ cashStatus: value })}
            value={filters.cashStatus}
          >
            {cashStatuses.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label={t("operations.settlementStatus")}
            onChange={(value) => updateFilters({ settlementStatus: value })}
            value={filters.settlementStatus}
          >
            {settlementStatuses.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </FilterSelect>
          <label className="filter-select">
            <span>{t("operations.grouping")}</span>
            <select
              onChange={(event) => changeGrouping(event.target.value as OrderGrouping)}
              value={grouping}
            >
              <option value="">{t("operations.clearGrouping")}</option>
              <option value="status">{t("operations.groupByStatus")}</option>
              <option value="driver">{t("operations.groupByDriver")}</option>
            </select>
          </label>
          <label className="filter-date">
            <span>{t("operations.dateFrom")}</span>
            <input
              onChange={(event) => updateFilters({ dateFrom: event.target.value })}
              type="date"
              value={filters.dateFrom}
            />
          </label>
          <label className="filter-date">
            <span>{t("operations.dateTo")}</span>
            <input
              onChange={(event) => updateFilters({ dateTo: event.target.value })}
              type="date"
              value={filters.dateTo}
            />
          </label>
          <button
            className="button button-link"
            onClick={() => {
              // Clear Filters keeps the selected view and the page size; it
              // clears the filters that apply to it and resets the page.
              list.setFilters({
                ...Object.fromEntries(orderFilterKeys.map((key) => [key, ""])),
                quickView: filters.quickView,
                ...(filters.quickView === "delivery"
                  ? { dateMode: "calendar_date", deliveredOnly: "true" }
                  : {}),
              });
              setFilterEmirateId("");
              setFilterArea(undefined);
            }}
            type="button"
          >
            {t("operations.clearFilters")}
          </button>
        </div>

        {selectedCount > 0 ? (
          <div className="bulk-toolbar" role="region" aria-label={t("operations.bulkActions")}>
            <div>
              <CheckSquare aria-hidden="true" size={18} />
              <strong>
                {t("operations.selectedCount", { count: summary?.selectedCount ?? selectedCount })}
              </strong>
              <span>{formatCurrency(summary?.selectedAmountToCollect ?? "0", "AED", locale)}</span>
            </div>
            <div className="bulk-actions">
              {canAssignDriver ? (
                <button onClick={() => setBulkAction("assign")} type="button">
                  <Truck aria-hidden="true" size={17} />
                  {t("operations.assignDriver")}
                </button>
              ) : null}
              {canReconcile ? (
                <button onClick={() => setBulkAction("collect")} type="button">
                  <HandCoins aria-hidden="true" size={17} />
                  {t("operations.actions.collectMoney")}
                </button>
              ) : null}
              {canSettle ? (
                <button onClick={() => onNavigate("/trader-settlements")} type="button">
                  <Banknote aria-hidden="true" size={17} />
                  {t("operations.actions.moneyOut")}
                </button>
              ) : null}
              {canUpdateStatus ? (
                <button onClick={() => setBulkAction("status")} type="button">
                  <MoreHorizontal aria-hidden="true" size={17} />
                  {t("operations.changeStatus")}
                </button>
              ) : null}
              {canManifest ? (
                <button onClick={() => setBulkAction("manifest")} type="button">
                  <Printer aria-hidden="true" size={17} />
                  {t("operations.actions.printManifest")}
                </button>
              ) : null}
              <button className="button-link" onClick={clearSelection} type="button">
                {t("common.clear")}
              </button>
            </div>
          </div>
        ) : null}

        {orderActionNotice === undefined ? null : (
          <div className="alert alert-info" role="status">
            {orderActionNotice}
          </div>
        )}
        <div className="orders-table-scroll" ref={ordersScrollRef}>
          <table className="orders-table">
            <thead>
              <tr>
                <th>
                  {grouping === "" && canSelectOrders ? (
                    <input
                      aria-label={t("operations.selectCurrentPage")}
                      checked={pageSelected}
                      onChange={togglePage}
                      type="checkbox"
                    />
                  ) : (
                    <span className="sr-only">{t("operations.groupSelection")}</span>
                  )}
                </th>
                <th>{t("operations.serialNumber")}</th>
                <th>{t("operations.referenceNumber")}</th>
                <th>{t("operations.trader")}</th>
                <th>{t("operations.customer")}</th>
                <th>{t("operations.assignedDriver")}</th>
                <th>{t("operations.codAmount")}</th>
                <th>{t("operations.totalDeductions")}</th>
                <th>{t("operations.amountDueToTrader")}</th>
                <th>{t("operations.amountToCollect")}</th>
                <th>{t("operations.deliveryStatus")}</th>
                {!deliveryView ? null : (
                  <>
                    <th>{t("operations.deliveryDateTime")}</th>
                    <th>{t("operations.deliveryBusinessDate")}</th>
                  </>
                )}
                <th>{t("operations.accountingColumn")}</th>
                <th>{t("operations.financialStatusColumn")}</th>
                <th>
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grouping === ""
                ? orderItems.map(renderOrderRow)
                : groups.map((group) => {
                    const ids = group.orders.map((order) => order.id);
                    const selectedInGroup = ids.filter(orderSelected).length;
                    const expanded = !collapsedGroups.has(group.key);
                    return (
                      <Fragment key={group.key}>
                        <tr className="order-group-row">
                          <td>
                            {canSelectOrders ? (
                              <GroupSelectionCheckbox
                                checked={selectedInGroup === ids.length && ids.length > 0}
                                indeterminate={selectedInGroup > 0 && selectedInGroup < ids.length}
                                label={t("operations.selectVisibleGroup", {
                                  group: group.label,
                                })}
                                onChange={() => toggleGroup(ids)}
                              />
                            ) : null}
                          </td>
                          <td colSpan={13 + deliveryColumns}>
                            <button
                              aria-expanded={expanded}
                              className="order-group-toggle"
                              onClick={() => toggleCollapsedGroup(group.key)}
                              type="button"
                            >
                              {expanded ? (
                                <ChevronDown aria-hidden="true" size={18} />
                              ) : (
                                <ChevronRight aria-hidden="true" size={18} />
                              )}
                              <strong>{group.label}</strong>
                              <span>
                                {t("operations.visibleOrderCount", { count: ids.length })}
                              </span>
                              {selectedInGroup > 0 ? (
                                <span>
                                  {t("operations.groupSelectedCount", {
                                    count: selectedInGroup,
                                  })}
                                </span>
                              ) : null}
                            </button>
                          </td>
                        </tr>
                        {expanded ? group.orders.map(renderOrderRow) : null}
                      </Fragment>
                    );
                  })}
              {!loading && orderItems.length === 0 ? (
                <tr>
                  <td className="empty-state" colSpan={14 + deliveryColumns}>
                    {t("operations.noOrders")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {/* Placed after the table and before the selection and pagination
            controls, so a sticky bar can never sit on top of them. */}
        <StickyHorizontalScrollbar
          label={t("operations.ordersHorizontalScroll")}
          targetRef={ordersScrollRef}
        />
        {grouping === "" &&
        pageSelected &&
        !allMatching &&
        (data?.filteredCount ?? 0) > pageIds.length ? (
          <button
            className="select-all-matching"
            onClick={() => {
              setAllMatching(true);
              setSelectedIds(new Set());
            }}
            type="button"
          >
            {t("operations.selectAllMatching", { count: data?.filteredCount ?? 0 })}
          </button>
        ) : null}
        <footer className="orders-pagination">
          <span>
            {t("operations.resultCount", {
              filtered: data?.filteredCount ?? 0,
              total: data?.totalCount ?? 0,
            })}
          </span>
          <label>
            <span>{t("operations.pageSize")}</span>
            <select
              onChange={(event) => {
                setPageSize(Number(event.target.value) as 25 | 50 | 100);
              }}
              value={pageSize}
            >
              {[25, 50, 100].map((size) => (
                <option key={size}>{size}</option>
              ))}
            </select>
          </label>
          <button
            aria-label={t("operations.previousPage")}
            className="icon-button"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={18} />
          </button>
          <strong>{page}</strong>
          <button
            aria-label={t("operations.nextPage")}
            className="icon-button"
            disabled={page * pageSize >= (data?.filteredCount ?? 0)}
            onClick={() => setPage(page + 1)}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={18} />
          </button>
        </footer>
      </section>
      {createOpen ? (
        <CreateOrderDialog
          api={api}
          drivers={drivers}
          permissions={permissions}
          onClose={() => setCreateOpen(false)}
          onSaved={load}
        />
      ) : null}
      {fastEntryOpen ? (
        <FastOrderEntryDialog
          api={api}
          emirates={emirates}
          onClose={() => setFastEntryOpen(false)}
          onSaved={load}
          textLanguage={textLanguage}
        />
      ) : null}
      {bulkAction === "assign" ? (
        <AssignDriverDialog
          api={api}
          drivers={drivers}
          selection={selection}
          onClose={() => setBulkAction(undefined)}
          onComplete={async () => {
            setBulkAction(undefined);
            clearSelection();
            await load();
          }}
        />
      ) : null}
      {bulkAction === "status" ? (
        <BulkStatusDialog
          api={api}
          selection={selection}
          onClose={() => setBulkAction(undefined)}
          onComplete={async () => {
            setBulkAction(undefined);
            clearSelection();
            await load();
          }}
        />
      ) : null}
      {bulkAction === "collect" ? (
        <CollectMoneyDialog
          api={api}
          drivers={drivers}
          onClose={() => setBulkAction(undefined)}
          onComplete={async () => {
            setBulkAction(undefined);
            clearSelection();
            await load();
          }}
          selection={selection}
        />
      ) : null}
      {bulkAction === "manifest" ? (
        <DriverShipmentManifestDialog
          api={api}
          onClose={() => setBulkAction(undefined)}
          selection={manifestSelection}
        />
      ) : null}
    </>
  );
}

type FastEntryStatus = "draft" | "ready" | "created" | "error";

interface FastEntryRow {
  additionalFees: string;
  areaId: string;
  areaOption: CompanyArea | undefined;
  codAmount: string;
  customerAddress: string;
  customerOption: CustomerOption | undefined;
  customerName: string;
  emirateId: string;
  id: string;
  notes: string;
  overrideReason: string;
  packageCount: string;
  referenceNumber: string;
  resolvedServiceFee: string;
  serialNumber: string;
  serviceFee: string;
  submissionKey: string;
  status: FastEntryStatus;
  traderId: string;
  traderOption: OperationsTraderOption | undefined;
  mobile: string;
  message?: string | undefined;
}

const fastEntryColumns = [
  "serialNumber",
  "referenceNumber",
  "traderId",
  "customerName",
  "mobile",
  "emirateId",
  "areaId",
  "customerAddress",
  "codAmount",
  "serviceFee",
  "additionalFees",
  "packageCount",
  "notes",
] as const;

function createFastEntrySubmissionKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `fast-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createFastEntryRow(serialNumber = ""): FastEntryRow {
  return {
    additionalFees: "0.00",
    areaId: "",
    areaOption: undefined,
    codAmount: "0.00",
    customerAddress: "",
    customerOption: undefined,
    customerName: "",
    emirateId: "",
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    notes: "",
    overrideReason: "",
    packageCount: "1",
    referenceNumber: "",
    resolvedServiceFee: "",
    serialNumber,
    serviceFee: "",
    submissionKey: createFastEntrySubmissionKey(),
    status: "draft",
    traderId: "",
    traderOption: undefined,
    mobile: "",
  };
}

function incrementSerial(base: string, offset: number): string {
  const value = base.trim();
  if (value === "" || offset === 0) return value;
  const match = /^(.*?)(\d+)$/.exec(value);
  if (match === null) return value;
  const prefix = match[1] ?? "";
  const digits = match[2] ?? "";
  return `${prefix}${String(Number(digits) + offset).padStart(digits.length, "0")}`;
}

function parseFastEntryMoney(value: string, required = false): number | undefined {
  const parsed = parseMoneyInput(value, { allowZero: !required, required });
  return parsed.ok ? parsed.value : undefined;
}

function isFastEntryMobileValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 32 &&
    Array.from(trimmed).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
  );
}

function mobileComparisonKey(input: string | null | undefined): string {
  const digits = (input ?? "").replace(/[^0-9]/g, "");
  if (/^05[0-9]{8}$/.test(digits)) return `971${digits.slice(1)}`;
  if (/^5[0-9]{8}$/.test(digits)) return `971${digits}`;
  return digits;
}

function normalizedAddress(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function rowHasFastEntryContent(row: FastEntryRow): boolean {
  return fastEntryColumns.some(
    (column) =>
      column !== "serialNumber" &&
      column !== "referenceNumber" &&
      row[column].trim() !== "" &&
      row[column] !== "0.00" &&
      row[column] !== "1",
  );
}

function resolveApiMessage(requestError: unknown, fallback: string): string {
  const sanitize = (message: string) =>
    message.includes("Cannot read properties of undefined") ? fallback : message;
  if (requestError instanceof ApiError) {
    const details = Array.isArray(requestError.details) ? requestError.details.filter(Boolean) : [];
    const message =
      details.length > 0 ? `${requestError.message}: ${details.join(" ")}` : requestError.message;
    if (requestError.code === "idempotency_key_reused") {
      return tSafeOrderMessage(
        "This row was already submitted with different details. Change the row or remove it and add it again.",
        fallback,
      );
    }
    return sanitize(message);
  }
  return requestError instanceof Error ? sanitize(requestError.message) : fallback;
}

function tSafeOrderMessage(message: string, fallback: string): string {
  return message.trim() === "" ? fallback : message;
}

function FastOrderEntryDialog({
  api,
  emirates,
  onClose,
  onSaved,
  textLanguage,
}: {
  api: ApiClient;
  emirates: readonly Emirate[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  textLanguage: "ar" | "en";
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const emirateOptions = Array.isArray(emirates) ? emirates : [];
  const fastEntryTraderLabel = useCallback(
    (option: OperationsTraderOption) =>
      localizeName(textLanguage, { ar: option.nameAr, en: option.nameEn }),
    [textLanguage],
  );
  const [rows, setRows] = useState<FastEntryRow[]>(() =>
    Array.from({ length: 3 }, () => createFastEntryRow()),
  );
  const [pasteText, setPasteText] = useState("");
  const [rowsToAdd, setRowsToAdd] = useState("5");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const tableScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollContainer = tableScrollRef.current;
    if (scrollContainer !== null) {
      scrollContainer.scrollLeft = 0;
      scrollContainer.scrollTop = 0;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void api
      .get<{ serialNumber: string }>("operations/orders/next-serial-number")
      .then((result) => {
        if (!active) return;
        setRows((current) =>
          current.map((row, index) => ({
            ...row,
            serialNumber:
              row.serialNumber.trim() === ""
                ? incrementSerial(result.serialNumber, index)
                : row.serialNumber,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  const updateRow = (id: string, change: Partial<FastEntryRow>) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              ...change,
              message: undefined,
              resolvedServiceFee:
                change.resolvedServiceFee !== undefined || row.status === "created"
                  ? (change.resolvedServiceFee ?? row.resolvedServiceFee)
                  : "",
              submissionKey:
                row.status === "created" || change.status !== undefined
                  ? row.submissionKey
                  : createFastEntrySubmissionKey(),
              status: row.status === "created" ? "created" : "draft",
            }
          : row,
      ),
    );
  };

  const addRows = (count: number) => {
    const safeCount = Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 100) : 5;
    setRows((current) => {
      const lastSerial =
        [...current].reverse().find((row) => row.serialNumber.trim() !== "")?.serialNumber ?? "";
      return [
        ...current,
        ...Array.from({ length: safeCount }, (_, index) =>
          createFastEntryRow(incrementSerial(lastSerial, index + 1)),
        ),
      ];
    });
  };

  const importPastedRows = () => {
    const lines = pasteText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0) return;
    const imported = lines.map((line) => {
      const parts = line.includes("\t") ? line.split("\t") : line.split(",");
      const row = createFastEntryRow();
      fastEntryColumns.forEach((column, index) => {
        const raw = parts[index]?.trim() ?? "";
        if (raw !== "") {
          Object.assign(row, { [column]: raw });
        }
      });
      row.additionalFees = row.additionalFees.trim() === "" ? "0.00" : row.additionalFees;
      row.packageCount = row.packageCount.trim() === "" ? "1" : row.packageCount;
      row.codAmount = row.codAmount.trim() === "" ? "0.00" : row.codAmount;
      return row;
    });
    setRows((current) => [...current.filter(rowHasFastEntryContent), ...imported]);
    setPasteText("");
  };

  const validateRows = useCallback(
    async (targetRows: readonly FastEntryRow[]) => {
      const serialCounts = new Map<string, number>();
      const referenceCounts = new Map<string, number>();
      for (const row of targetRows) {
        if (!rowHasFastEntryContent(row) || row.status === "created") continue;
        const serial = row.serialNumber.trim();
        if (serial !== "") serialCounts.set(serial, (serialCounts.get(serial) ?? 0) + 1);
        const reference = row.referenceNumber.trim();
        if (reference !== "")
          referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1);
      }

      return Promise.all(
        targetRows.map(async (row): Promise<FastEntryRow> => {
          if (!rowHasFastEntryContent(row) || row.status === "created") return row;
          const errors: string[] = [];
          const serial = row.serialNumber.trim();
          const reference = row.referenceNumber.trim();
          const cod = parseFastEntryMoney(row.codAmount, true);
          const additionalFees = parseFastEntryMoney(row.additionalFees);
          const serviceFee =
            row.serviceFee.trim() === "" ? undefined : parseFastEntryMoney(row.serviceFee);
          const packages = parseNumericInput(row.packageCount, {
            allowZero: false,
            required: true,
            wholeNumber: true,
          });

          if (serial === "") errors.push(t("operations.errors.serialRequired"));
          if ((serialCounts.get(serial) ?? 0) > 1)
            errors.push(t("operations.fastEntryDuplicateSerial"));
          if (reference !== "" && (referenceCounts.get(reference) ?? 0) > 1)
            errors.push(t("operations.fastEntryDuplicateReference"));
          if (row.traderId === "") errors.push(t("operations.errors.traderRequired"));
          if (row.customerName.trim() === "")
            errors.push(t("operations.errors.customerNameRequired"));
          if (row.mobile.trim() === "") errors.push(t("operations.errors.mobileRequired"));
          if (row.mobile.trim() !== "" && !isFastEntryMobileValid(row.mobile))
            errors.push(t("operations.fastEntryMobileInvalid"));
          if (row.emirateId === "") errors.push(t("areas.selectEmirate"));
          if (row.areaId === "") errors.push(t("operations.errors.areaRequired"));
          // Address is optional here too, matching the Create Order dialog.
          if (cod === undefined) errors.push(t("operations.errors.codInvalid"));
          if (additionalFees === undefined) errors.push(t("operations.errors.additionalInvalid"));
          if (serviceFee === undefined && row.serviceFee.trim() !== "")
            errors.push(t("operations.errors.overrideFeeInvalid"));
          if (row.serviceFee.trim() !== "" && row.overrideReason.trim() === "")
            errors.push(t("operations.errors.overrideReasonRequired"));
          if (!packages.ok) errors.push(t("operations.errors.packagesInvalid"));

          let customerOption: CustomerOption | undefined;
          if (errors.length === 0) {
            try {
              const page = await api.get<SearchPage<CustomerOption>>(
                `configuration/customers/search?search=${encodeURIComponent(row.mobile.trim())}&limit=10&offset=0`,
              );
              const requestedMobileKey = mobileComparisonKey(row.mobile);
              customerOption = (Array.isArray(page.items) ? page.items : []).find(
                (option) =>
                  mobileComparisonKey(option.mobileNumber) === requestedMobileKey ||
                  mobileComparisonKey(option.secondMobileNumber) === requestedMobileKey,
              );
              if (customerOption !== undefined) {
                const sameArea = customerOption.areaId === row.areaId;
                const sameAddress =
                  normalizedAddress(customerOption.address) ===
                  normalizedAddress(row.customerAddress);
                if (!sameArea || !sameAddress) {
                  errors.push(t("operations.fastEntryExistingCustomerAddressMismatch"));
                  customerOption = undefined;
                }
              }
            } catch {
              errors.push(t("operations.fastEntryValidationFailed"));
            }
          }

          if (errors.length === 0 && serial !== "") {
            try {
              const query = new URLSearchParams({ serialNumber: serial });
              if (reference !== "") query.set("referenceNumber", reference);
              const availability = await api.get<{
                referenceNumberAvailable: boolean;
                serialNumberAvailable: boolean;
              }>(`operations/orders/identifier-availability?${query.toString()}`);
              if (!availability.serialNumberAvailable)
                errors.push(t("operations.serialNumberExists"));
              if (!availability.referenceNumberAvailable)
                errors.push(t("operations.referenceNumberExists"));
            } catch {
              errors.push(t("operations.fastEntryValidationFailed"));
            }
          }

          if (
            errors.length === 0 &&
            row.traderId !== "" &&
            row.areaId !== "" &&
            cod !== undefined
          ) {
            try {
              const quote = await api.post<OperationsOrderQuote>("operations/orders/quote", {
                additionalFees: additionalFees ?? 0,
                areaId: row.areaId,
                codAmount: cod,
                serviceFee,
                serviceFeeOverrideReason:
                  row.serviceFee.trim() === "" ? undefined : row.overrideReason.trim(),
                traderId: row.traderId,
              });
              row = {
                ...row,
                resolvedServiceFee: quote.serviceFee,
              };
            } catch (requestError) {
              errors.push(resolveApiMessage(requestError, t("operations.quoteFailed")));
            }
          }

          return {
            ...row,
            customerOption,
            message: errors.length === 0 ? t("operations.fastEntryReady") : errors.join(" "),
            status: errors.length === 0 ? "ready" : "error",
          };
        }),
      );
    },
    [api, t],
  );

  const createOrders = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const validated = await validateRows(rows);
      const activeValidatedRows = validated.filter(
        (row) => rowHasFastEntryContent(row) && row.status !== "created",
      );
      const rowsWithErrors = activeValidatedRows.filter((row) => row.status === "error");
      if (activeValidatedRows.length === 0) {
        setRows(validated);
        setMessage(t("operations.fastEntryNoRowsToCreate"));
        return;
      }
      if (rowsWithErrors.length > 0) {
        setRows(validated);
        setMessage(t("operations.fastEntryFixRowsBeforeCreate", { count: rowsWithErrors.length }));
        return;
      }
      const nextRows = [...validated];
      let stoppedOnCreateError = false;
      for (let index = 0; index < nextRows.length; index += 1) {
        const row = nextRows[index];
        if (row === undefined) continue;
        if (row.status !== "ready") continue;
        const cod = parseFastEntryMoney(row.codAmount, true) ?? 0;
        const additionalFees = parseFastEntryMoney(row.additionalFees) ?? 0;
        const serviceFee =
          row.serviceFee.trim() === "" ? undefined : parseFastEntryMoney(row.serviceFee);
        const packages = parseNumericInput(row.packageCount, {
          allowZero: false,
          required: true,
          wholeNumber: true,
        });
        try {
          const existingCustomer = row.customerOption;
          const customerPayload =
            existingCustomer === undefined
              ? {
                  customerAddressId: undefined,
                  customerId: undefined,
                  inlineCustomer: {
                    address: row.customerAddress.trim(),
                    areaId: row.areaId,
                    mobileNumber: row.mobile.trim(),
                    name: row.customerName.trim(),
                  },
                }
              : {
                  customerAddressId: existingCustomer.addressId,
                  customerId: existingCustomer.id,
                  inlineCustomer: undefined,
                };
          await api.post<OperationsOrder>(
            "operations/orders",
            {
              additionalFees,
              areaId: row.areaId,
              codAmount: cod,
              customerAddressId: customerPayload.customerAddressId,
              customerAddress: row.customerAddress.trim(),
              customerId: customerPayload.customerId,
              customerMobileNumber: row.mobile.trim(),
              customerName: row.customerName.trim(),
              customerSecondMobileNumber: undefined,
              driverId: undefined,
              inlineCustomer: customerPayload.inlineCustomer,
              notes: row.notes.trim() || undefined,
              packageCount: packages.ok ? packages.value : 1,
              referenceNumber: row.referenceNumber.trim() || undefined,
              serialNumber: row.serialNumber.trim(),
              serviceFee,
              serviceFeeOverrideReason:
                row.serviceFee.trim() === "" ? undefined : row.overrideReason.trim(),
              traderId: row.traderId,
            },
            {
              "X-Idempotency-Key": row.submissionKey,
            },
          );
          nextRows[index] = {
            ...row,
            message: t("operations.fastEntryCreated"),
            status: "created",
          };
        } catch (requestError) {
          nextRows[index] = {
            ...row,
            message: resolveApiMessage(requestError, t("operations.createOrderFailed")),
            status: "error",
          };
          setRows([...nextRows]);
          setMessage(resolveApiMessage(requestError, t("operations.createOrderFailed")));
          stoppedOnCreateError = true;
          break;
        }
        setRows([...nextRows]);
      }
      await onSaved();
      if (stoppedOnCreateError) return;
      const createdCount = nextRows.filter((row) => row.status === "created").length;
      setMessage(t("operations.fastEntryCreatedCount", { count: createdCount }));
    } finally {
      setBusy(false);
    }
  };

  const readyRows = rows.filter((row) => row.status === "ready").length;
  const createdRows = rows.filter((row) => row.status === "created").length;
  const activeRows = rows.filter((row) => rowHasFastEntryContent(row) && row.status !== "created");

  return (
    <Modal
      className="fast-entry-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.fastEntryTitle")}
      titleId="fast-order-entry-title"
    >
      <div className="fast-entry-workspace">
        <p className="form-hint">{t("operations.fastEntryHelp")}</p>
        {message === undefined ? null : <div className="alert alert-info">{message}</div>}
        <div className="fast-entry-toolbar">
          <label className="fast-entry-add-count">
            <span>{t("operations.fastEntryRowsToAdd")}</span>
            <input
              min="1"
              max="100"
              onChange={(event) => setRowsToAdd(event.target.value)}
              step="1"
              type="number"
              value={rowsToAdd}
            />
          </label>
          <button
            disabled={busy}
            onClick={() => addRows(Number.parseInt(rowsToAdd, 10))}
            type="button"
          >
            {t("operations.fastEntryAddRows")}
          </button>
          <button
            className="button button-primary"
            disabled={busy || activeRows.length === 0}
            onClick={() => void createOrders()}
            type="button"
          >
            {t("operations.fastEntryCreateValid")}
          </button>
          <span>
            {t("operations.fastEntrySummary", {
              created: createdRows,
              ready: readyRows,
              total: rows.length,
            })}
          </span>
        </div>
        <details className="fast-entry-paste">
          <summary>{t("operations.fastEntryPasteTitle")}</summary>
          <p className="form-hint">{t("operations.fastEntryPasteHelp")}</p>
          <textarea
            onChange={(event) => setPasteText(event.target.value)}
            rows={4}
            value={pasteText}
          />
          <button
            disabled={pasteText.trim() === "" || busy}
            onClick={importPastedRows}
            type="button"
          >
            {t("operations.fastEntryUsePastedRows")}
          </button>
        </details>
        <div className="fast-entry-table-scroll" ref={tableScrollRef}>
          <table className="fast-entry-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("operations.serialNumber")}</th>
                <th>{t("operations.referenceNumber")}</th>
                <th>{t("operations.trader")}</th>
                <th>{t("operations.customerName")}</th>
                <th>{t("operations.mobile")}</th>
                <th>{t("areas.emirate")}</th>
                <th>{t("operations.areaField")}</th>
                <th>{t("operations.customerAddress")}</th>
                <th>{t("operations.codAmount")}</th>
                <th>{t("operations.serviceFee")}</th>
                <th>{t("operations.additionalFees")}</th>
                <th>{t("operations.packages")}</th>
                <th>{t("operations.notes")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr className={`fast-entry-row-${row.status}`} key={row.id}>
                  <td>{index + 1}</td>
                  <td>
                    <input
                      value={row.serialNumber}
                      onChange={(event) => updateRow(row.id, { serialNumber: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={row.referenceNumber}
                      onChange={(event) =>
                        updateRow(row.id, { referenceNumber: event.target.value })
                      }
                    />
                  </td>
                  <td>
                    <SearchCombobox<OperationsTraderOption>
                      api={api}
                      emptyText={t("operations.noTradersFound")}
                      getLabel={fastEntryTraderLabel}
                      getSelectedLabel={fastEntryTraderLabel}
                      label={t("operations.trader")}
                      onChange={(trader) =>
                        updateRow(row.id, {
                          traderId: trader?.id ?? "",
                          traderOption: trader,
                        })
                      }
                      path="operations/traders/search"
                      placeholder={t("operations.searchTrader")}
                      value={row.traderOption}
                    />
                  </td>
                  <td>
                    <input
                      value={row.customerName}
                      onChange={(event) => updateRow(row.id, { customerName: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={row.mobile}
                      onChange={(event) => updateRow(row.id, { mobile: event.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={row.emirateId}
                      onChange={(event) => {
                        const emirateId = event.target.value;
                        updateRow(row.id, { areaId: "", areaOption: undefined, emirateId });
                      }}
                    >
                      <option value="">{t("areas.selectEmirate")}</option>
                      {emirateOptions.map((emirate) => (
                        <option key={emirate.id} value={emirate.id}>
                          {localizeName(textLanguage, { ar: emirate.nameAr, en: emirate.nameEn })}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <SearchCombobox<CompanyArea>
                      api={api}
                      emptyText={t("areas.noneFound")}
                      getLabel={(area) =>
                        localizeName(textLanguage, { ar: area.nameAr, en: area.nameEn })
                      }
                      label={t("operations.areaField")}
                      key={`${row.id}-${row.emirateId}`}
                      onChange={(area) =>
                        updateRow(row.id, {
                          areaId: area?.id ?? "",
                          areaOption: area,
                          emirateId: area?.emirateId ?? row.emirateId,
                        })
                      }
                      path={
                        row.emirateId === ""
                          ? "configuration/areas/search"
                          : `configuration/areas/search?emirateId=${encodeURIComponent(row.emirateId)}`
                      }
                      placeholder={t("operations.selectArea")}
                      value={row.areaOption}
                    />
                  </td>
                  <td>
                    <input
                      value={row.customerAddress}
                      onChange={(event) =>
                        updateRow(row.id, { customerAddress: event.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      min="0"
                      step="0.01"
                      type="number"
                      value={row.codAmount}
                      onChange={(event) => updateRow(row.id, { codAmount: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      min="0"
                      placeholder={t("operations.fastEntryAutoFee")}
                      step="0.01"
                      type="number"
                      value={row.serviceFee || row.resolvedServiceFee}
                      onChange={(event) => updateRow(row.id, { serviceFee: event.target.value })}
                      title={
                        row.serviceFee.trim() === ""
                          ? t("operations.fastEntryAutoFeeHint")
                          : undefined
                      }
                    />
                    {row.serviceFee.trim() === "" ? null : (
                      <input
                        className="fast-entry-override-reason"
                        placeholder={t("operations.overrideReason")}
                        value={row.overrideReason}
                        onChange={(event) =>
                          updateRow(row.id, { overrideReason: event.target.value })
                        }
                      />
                    )}
                  </td>
                  <td>
                    <input
                      min="0"
                      step="0.01"
                      type="number"
                      value={row.additionalFees}
                      onChange={(event) =>
                        updateRow(row.id, { additionalFees: event.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      min="1"
                      step="1"
                      type="number"
                      value={row.packageCount}
                      onChange={(event) => updateRow(row.id, { packageCount: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={row.notes}
                      onChange={(event) => updateRow(row.id, { notes: event.target.value })}
                    />
                  </td>
                  <td>
                    {row.message === undefined ? null : (
                      <span className="fast-entry-row-message">{row.message}</span>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        setRows((current) =>
                          current.length <= 1
                            ? [createFastEntryRow()]
                            : current.filter((candidate) => candidate.id !== row.id),
                        )
                      }
                      type="button"
                    >
                      {t("common.remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={15}>
                  {t("operations.fastEntryTotalCod", {
                    amount: formatCurrency(
                      rows
                        .reduce((sum, row) => sum + (parseFastEntryMoney(row.codAmount) ?? 0), 0)
                        .toFixed(2),
                      "AED",
                      locale,
                    ),
                  })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export function OrderDetailsWorkspace({
  api,
  companyId,
  onBack,
  onNavigate,
  orderNumber,
  permissions = [],
}: {
  api: ApiClient;
  companyId: string;
  onBack: () => void;
  onNavigate?: (path: string) => void;
  orderNumber: string;
  permissions?: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const branding = useContext(CompanyBrandingContext);
  const reportLanguage = branding?.textLanguage === "ar" ? "ar" : "en";
  const cashStatusLabel = useDriverCashStatusLabel();
  const [detail, setDetail] = useState<OperationsOrderDetail>();
  const [historyFilter, setHistoryFilter] = useState("all");
  const [editOpen, setEditOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [collectOpen, setCollectOpen] = useState(false);
  const [viewCollectionId, setViewCollectionId] = useState<string>();
  const [collectionError, setCollectionError] = useState<string>();
  const [collectionSummary, setCollectionSummary] = useState<{
    businessDate: string;
    collectionPaymentMethod: "cash" | "visa" | null;
    customerAmountToCollect: string;
    driverName: string;
    reconciliationId: string;
    reconciliationNumber: string;
    statusLabel: string;
  }>();
  const [viewSettlementId, setViewSettlementId] = useState<string>();
  const [settlementError, setSettlementError] = useState<string>();
  const [settlementSummary, setSettlementSummary] = useState<{
    amountPaidNow: string;
    moneyReceivedDate: string | null;
    moneySentAt: string | null;
    paymentDate: string;
    paymentMethod: "bank_transfer" | "cash";
    settlementId: string;
    settlementNumber: string;
    status: "confirmed" | "reversed";
    traderName: string;
  }>();
  const pdf = useReconciliationPdfActions(api);
  const settlementPdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setDetail(
        await api.get<OperationsOrderDetail>(
          `operations/order-details/${encodeURIComponent(orderNumber)}`,
        ),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("operations.detailLoadFailed"),
      );
    }
  }, [api, orderNumber, t]);
  useEffect(() => void load(), [load]);
  // Eagerly resolve the compact Driver Collection summary shown on the Order
  // detail page — the same server-authoritative report-data endpoint the
  // Driver Collections screen uses, never a second report record.
  useEffect(() => {
    if (detail === undefined || detail.driverReconciliationStatus !== "reconciled") {
      setCollectionSummary(undefined);
      return;
    }
    let active = true;
    void api
      .get<{ reconciliationId: string; reconciliationNumber: string } | undefined>(
        `operations/orders/${detail.id}/driver-collection`,
      )
      .then((link) => {
        if (!active || link === undefined) return undefined;
        return api
          .get<{
            header: {
              businessDate: string;
              collectionPaymentMethod: "cash" | "visa" | null;
              driverName: string;
              statusLabel: string;
            };
            orders: readonly { customerAmountToCollect: string; serialNumber: string }[];
          }>(`operations/cash/reconciliations/${link.reconciliationId}/report-data`)
          .then((data) => {
            if (!active) return;
            const own = data.orders.find((row) => row.serialNumber === detail.serialNumber);
            setCollectionSummary({
              businessDate: data.header.businessDate,
              collectionPaymentMethod: data.header.collectionPaymentMethod,
              customerAmountToCollect: own?.customerAmountToCollect ?? "0.00",
              driverName: data.header.driverName,
              reconciliationId: link.reconciliationId,
              reconciliationNumber: link.reconciliationNumber,
              statusLabel: data.header.statusLabel,
            });
          });
      })
      .catch((requestError: unknown) => {
        if (active) setCollectionError(message(requestError, t("operations.detailLoadFailed")));
      });
    return () => {
      active = false;
    };
  }, [api, detail, t]);

  useEffect(() => {
    if (
      detail === undefined ||
      ["not_eligible", "unsettled"].includes(detail.traderSettlementStatus)
    ) {
      setSettlementSummary(undefined);
      return;
    }
    let active = true;
    setSettlementError(undefined);
    void api
      .get<{ settlementId: string; settlementNumber: string } | undefined>(
        `operations/orders/${detail.id}/trader-settlement`,
      )
      .then((link) => {
        if (!active || link === undefined) return undefined;
        return api
          .get<{
            header: {
              moneyReceivedDate: string | null;
              moneySentAt: string | null;
              paymentDate: string;
              paymentMethod: "bank_transfer" | "cash";
              settlementNumber: string;
              status: "confirmed" | "reversed";
              traderName: string;
            };
            summary: { amountPaidNow: string };
          }>(`operations/settlements/payments/${link.settlementId}/report-data`)
          .then((data) => {
            if (!active) return;
            setSettlementSummary({
              amountPaidNow: data.summary.amountPaidNow,
              moneyReceivedDate: data.header.moneyReceivedDate,
              moneySentAt: data.header.moneySentAt,
              paymentDate: data.header.paymentDate,
              paymentMethod: data.header.paymentMethod,
              settlementId: link.settlementId,
              settlementNumber: data.header.settlementNumber,
              status: data.header.status,
              traderName: data.header.traderName,
            });
          });
      })
      .catch((requestError: unknown) => {
        if (active) setSettlementError(message(requestError, t("operations.detailLoadFailed")));
      });
    return () => {
      active = false;
    };
  }, [api, detail, t]);

  const openConfirmedCollectionPdf = async (mode: PdfAction) => {
    if (collectionSummary === undefined) return;
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/cash/reconciliations/${collectionSummary.reconciliationId}/pdf?language=en`,
      `Driver-Collection-${collectionSummary.reconciliationNumber}.pdf`,
      mode,
    );
    if (requestError !== undefined) {
      setPdfError(message(requestError, t("operations.pdfGenerationFailed")));
    }
  };

  const openConfirmedSettlementPdf = async (mode: PdfAction) => {
    if (settlementSummary === undefined) return;
    setPdfError(undefined);
    const requestError = await settlementPdf.run(
      `operations/settlements/payments/${settlementSummary.settlementId}/pdf?language=${reportLanguage}`,
      `Trader-Settlement-${settlementSummary.settlementNumber}.pdf`,
      mode,
    );
    if (requestError !== undefined) {
      setPdfError(message(requestError, t("operations.pdfGenerationFailed")));
    }
  };
  if (error !== undefined)
    return (
      <section className="route-message" role="alert">
        <h1>{t("operations.orderNotFound")}</h1>
        <p>{error}</p>
        <button className="button button-secondary" onClick={onBack} type="button">
          {t("common.back")}
        </button>
      </section>
    );
  if (detail === undefined) return <div className="loading-row">{t("common.loading")}</div>;
  const events =
    historyFilter === "all"
      ? detail.events
      : detail.events.filter((event) => event.category === historyFilter);
  const canViewSettlementReport =
    permissions.includes("settlements.create") ||
    permissions.includes("reports.export") ||
    permissions.includes("users_roles.manage");
  const canViewSettlementDetail =
    permissions.includes("settlements.create") || permissions.includes("users_roles.manage");
  const canReverseSettlement =
    permissions.includes("settlements.reverse") || permissions.includes("users_roles.manage");
  return (
    <>
      <div className="order-detail-header">
        <button className="button button-link" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={18} />
          {t("common.back")}
        </button>
        <div className="order-detail-title">
          <OrderBarcode value={detail.orderNumber} />
          <div>
            <span>
              {detail.serialNumber ? t("operations.serialNumber") : t("operations.order")}
            </span>
            <h1>{detail.serialNumber ?? detail.orderNumber}</h1>
            {detail.serialNumber ? (
              <small>
                {t("operations.systemOrderNumber")}: {detail.orderNumber}
              </small>
            ) : null}
            <p>
              {t("operations.createdByAt", {
                actor: detail.metadata.createdBy,
                date: formatDateTime(detail.metadata.createdAt, locale),
              })}
            </p>
          </div>
        </div>
        <div className="order-detail-actions">
          {["new", "assigned_to_driver", "out_for_delivery"].includes(detail.deliveryStatus) &&
          (permissions.includes("orders.update_delivery_status") ||
            permissions.includes("users_roles.manage")) ? (
            <button
              className="button button-secondary"
              onClick={() => setHoldOpen(true)}
              type="button"
            >
              {t("operations.actions.hold")}
            </button>
          ) : null}
          {canEditOrder(detail.deliveryStatus) ? (
            <button
              className="button button-secondary"
              onClick={() => setEditOpen(true)}
              type="button"
            >
              <Pencil aria-hidden="true" size={18} />
              {t("operations.editOrder")}
            </button>
          ) : null}
          <button
            className="button button-secondary"
            onClick={() =>
              openOrderWaybill(detail, locale, {
                address: t("operations.customerAddress"),
                amountDue: t("operations.amountToCollect"),
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
            <Printer aria-hidden="true" size={18} />
            {t("operations.printWaybill")}
          </button>
          <TrackingButton api={api} detail={detail} />
          {detail.driverReconciliationStatus === "pending" &&
          (permissions.includes("reconciliations.create") ||
            permissions.includes("users_roles.manage")) ? (
            <button
              className="button button-secondary"
              onClick={() => setCollectOpen(true)}
              type="button"
            >
              {t("operations.actions.collectMoney")}
            </button>
          ) : null}
        </div>
      </div>
      <div className="order-current-status">
        <span>{t("operations.currentOrderStatus")}</span>
        <DeliveryStatusBadge large order={detail} />
      </div>
      <main className="order-detail-layout">
        <DetailSection
          title={t("operations.orderOverview")}
          rows={[
            [t("operations.serialNumber"), detail.serialNumber ?? t("operations.legacyIdentifier")],
            [
              t("operations.referenceNumber"),
              detail.referenceNumber ?? t("operations.notProvided"),
            ],
            [t("operations.orderDate"), formatDate(detail.orderDate, locale)],
            [t("operations.areaField"), detail.areaName],
            [t("operations.packages"), String(detail.metadata.packageCount)],
            [
              t("operations.paymentCondition"),
              t(`operations.paymentConditions.${detail.metadata.paymentCondition}`, {
                defaultValue: detail.metadata.paymentCondition,
              }),
            ],
          ]}
        />
        <DetailSection
          title={t("operations.traderAndCustomer")}
          rows={[
            [t("operations.trader"), detail.traderName],
            [t("operations.customerName"), detail.customerName],
            [t("operations.mobile"), detail.customerMobileNumber],
            [t("operations.customerAddress"), detail.customerAddress],
          ]}
        />
        <DetailSection
          title={t("operations.driverAndAssignment")}
          rows={[
            [
              t("operations.assignedDriver"),
              detail.assignedDriverName ?? t("operations.unassigned"),
            ],
          ]}
        />
        <DetailSection
          title={t("operations.financialDetails")}
          rows={[
            [t("operations.codAmount"), money(detail.codAmount, locale)] as const,
            [t("operations.serviceFee"), money(detail.serviceFee, locale)] as const,
            [
              t("operations.feeSource"),
              t(`operations.feeSources.${orderFeeSource(detail.serviceFeeOverrideReason)}`),
            ] as const,
            // Only shown when a reason was actually recorded. A blank row would
            // imply the reason is missing, when for most Orders none is owed.
            ...(detail.serviceFeeOverrideReason == null ||
            detail.serviceFeeOverrideReason.trim() === ""
              ? []
              : [
                  [
                    t("operations.serviceFeeOverrideReason"),
                    detail.serviceFeeOverrideReason,
                  ] as const,
                ]),
            ...(detail.additionalFees == null
              ? []
              : [[t("operations.additionalFees"), money(detail.additionalFees, locale)] as const]),
            [t("operations.vatAmount"), money(detail.vatAmount, locale)] as const,
            ...(detail.totalDeductions == null
              ? []
              : [
                  [t("operations.totalDeductions"), money(detail.totalDeductions, locale)] as const,
                ]),
            [t("operations.amountToCollect"), money(detail.customerAmountDue, locale)] as const,
            [
              t("operations.amountDueToTrader"),
              money(detail.metadata.traderNetPayable, locale),
            ] as const,
            [t("operations.driverCost"), money(detail.metadata.driverCost, locale)] as const,
            [
              t("operations.returnDriverFee"),
              money(detail.metadata.returnDriverFee, locale),
            ] as const,
            [
              t("operations.orderExpenses"),
              money(detail.metadata.orderExpensesTotal, locale),
            ] as const,
            [t("operations.companyRevenue"), money(detail.companyRevenue, locale)] as const,
            [t("operations.profit"), money(detail.orderProfit, locale)] as const,
          ]}
        />
        <DetailSection
          title={t("operations.financialStatusColumn")}
          rows={[
            ...(orderAccountingStatus(detail) === null
              ? []
              : [
                  [
                    t("operations.accountingColumn"),
                    detail.accountingRequired === true
                      ? t("operations.accountingRequired")
                      : t("operations.noAccountingRequired"),
                  ] as const,
                  [
                    t("operations.accountingStatus"),
                    t(`operations.accountingStatuses.${orderAccountingStatus(detail)}`),
                  ] as const,
                ]),
            [t("operations.driverCashStatus"), cashStatusLabel(detail.driverReconciliationStatus)],
            [t("operations.settlementStatus"), t(`statuses.${detail.traderSettlementStatus}`)],
            [
              t("operations.outsourcedDriverFeeStatus"),
              t(`operations.outsourcedDriverFeeStatuses.${detail.outsourcedDriverFeeStatus}`, {
                defaultValue: detail.outsourcedDriverFeeStatus,
              }),
            ],
            ...(detail.outsourcedDriverFeeStatus === "not_required"
              ? []
              : [
                  [
                    t("operations.outsourcedDriverFeeAmount"),
                    detail.outsourcedDriverFeeAmount == null
                      ? "-"
                      : money(detail.outsourcedDriverFeeAmount, locale),
                  ] as const,
                  [
                    t("operations.outsourcedDriverFeePaid"),
                    detail.outsourcedDriverFeePaid == null
                      ? "-"
                      : money(detail.outsourcedDriverFeePaid, locale),
                  ] as const,
                  [
                    t("operations.outsourcedDriverFeeOutstanding"),
                    detail.outsourcedDriverFeeOutstanding == null
                      ? "-"
                      : money(detail.outsourcedDriverFeeOutstanding, locale),
                  ] as const,
                  ...(detail.outsourcedDriverFeePaymentNumbers == null ||
                  detail.outsourcedDriverFeePaymentNumbers.trim() === ""
                    ? []
                    : [
                        [
                          t("operations.outsourcedDriverFeePayments"),
                          detail.outsourcedDriverFeePaymentNumbers,
                        ] as const,
                      ]),
                ]),
          ]}
        />
        {collectionSummary === undefined ? null : (
          <section className="order-detail-section">
            <h2>{t("operations.collectionDetail")}</h2>
            <dl>
              <div>
                <dt>{t("operations.reconciliationNumber")}</dt>
                <dd>{collectionSummary.reconciliationNumber}</dd>
              </div>
              <div>
                <dt>{t("operations.driver")}</dt>
                <dd>{collectionSummary.driverName}</dd>
              </div>
              <div>
                <dt>{t("operations.collectionDateColumn")}</dt>
                <dd>{collectionSummary.businessDate}</dd>
              </div>
              <div>
                <dt>{t("operations.paymentMethod")}</dt>
                <dd>
                  {collectionSummary.collectionPaymentMethod === null
                    ? t("operations.paymentMethodNotAssigned")
                    : t(
                        `operations.paymentMethod${collectionSummary.collectionPaymentMethod === "cash" ? "Cash" : "Visa"}`,
                      )}
                </dd>
              </div>
              <div>
                <dt>{t("operations.customerAmountToCollect")}</dt>
                <dd>{money(collectionSummary.customerAmountToCollect, locale)}</dd>
              </div>
              <div>
                <dt>{t("operations.status")}</dt>
                <dd>{collectionSummary.statusLabel}</dd>
              </div>
            </dl>
            {pdfError === undefined ? null : (
              <div className="alert alert-error" role="alert">
                {pdfError}
              </div>
            )}
            <div className="modal-actions">
              <button
                disabled={pdf.busy !== undefined}
                onClick={() => setViewCollectionId(collectionSummary.reconciliationId)}
                type="button"
              >
                {t("operations.actions.viewCollection")}
              </button>
              <button
                disabled={pdf.busy !== undefined}
                onClick={() => void openConfirmedCollectionPdf("preview")}
                type="button"
              >
                {pdf.busy === "preview" ? t("common.loading") : t("operations.previewReport")}
              </button>
              <button
                disabled={pdf.busy !== undefined}
                onClick={() => void openConfirmedCollectionPdf("print")}
                type="button"
              >
                {pdf.busy === "print" ? t("common.loading") : t("common.print")}
              </button>
              <button
                disabled={pdf.busy !== undefined}
                onClick={() => void openConfirmedCollectionPdf("download")}
                type="button"
              >
                {pdf.busy === "download" ? t("common.loading") : t("operations.downloadPdf")}
              </button>
            </div>
          </section>
        )}
        {settlementSummary === undefined ? null : (
          <section className="order-detail-section">
            <h2>{t("traderSettlements.detailTitle")}</h2>
            <dl>
              <div>
                <dt>{t("traderSettlements.columnSettlementNumber")}</dt>
                <dd>{settlementSummary.settlementNumber}</dd>
              </div>
              <div>
                <dt>{t("operations.trader")}</dt>
                <dd>{settlementSummary.traderName}</dd>
              </div>
              <div>
                <dt>{t("traderSettlements.paymentDate")}</dt>
                <dd>{settlementSummary.paymentDate}</dd>
              </div>
              <div>
                <dt>{t("operations.paymentMethod")}</dt>
                <dd>
                  {t(
                    settlementSummary.paymentMethod === "cash"
                      ? "traderSettlements.paymentMethodCash"
                      : "traderSettlements.paymentMethodBankTransfer",
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("traderSettlements.amountPaidNow")}</dt>
                <dd>{money(settlementSummary.amountPaidNow, locale)}</dd>
              </div>
              <div>
                <dt>{t("traderSettlements.moneySentDate")}</dt>
                <dd>
                  {settlementSummary.moneySentAt === null
                    ? "-"
                    : settlementSummary.moneySentAt.slice(0, 10)}
                </dd>
              </div>
              <div>
                <dt>{t("traderSettlements.moneyReceivedDate")}</dt>
                <dd>
                  {settlementSummary.moneyReceivedDate === null
                    ? "-"
                    : settlementSummary.moneyReceivedDate.slice(0, 10)}
                </dd>
              </div>
              <div>
                <dt>{t("operations.status")}</dt>
                <dd>
                  {t(
                    settlementSummary.status === "reversed"
                      ? "traderSettlements.statusReversed"
                      : "traderSettlements.statusConfirmed",
                  )}
                </dd>
              </div>
            </dl>
            <div className="modal-actions">
              {!canViewSettlementDetail ? null : (
                <button
                  disabled={settlementPdf.busy !== undefined}
                  onClick={() => setViewSettlementId(settlementSummary.settlementId)}
                  type="button"
                >
                  {t("traderSettlements.actionView")}
                </button>
              )}
              {!canViewSettlementReport ? null : (
                <>
                  <button
                    disabled={settlementPdf.busy !== undefined}
                    onClick={() => void openConfirmedSettlementPdf("preview")}
                    type="button"
                  >
                    {settlementPdf.busy === "preview"
                      ? t("common.loading")
                      : t("traderSettlements.actionPreviewStatement")}
                  </button>
                  <button
                    disabled={settlementPdf.busy !== undefined}
                    onClick={() => void openConfirmedSettlementPdf("print")}
                    type="button"
                  >
                    {settlementPdf.busy === "print" ? t("common.loading") : t("common.print")}
                  </button>
                  <button
                    disabled={settlementPdf.busy !== undefined}
                    onClick={() => void openConfirmedSettlementPdf("download")}
                    type="button"
                  >
                    {settlementPdf.busy === "download"
                      ? t("common.loading")
                      : t("operations.downloadPdf")}
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        <section className="order-detail-section order-detail-wide">
          <h2>{t("operations.attachments")}</h2>
          {detail.attachments.length === 0 ? (
            <p className="muted">{t("operations.noAttachments")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("operations.attachmentType")}</th>
                  <th>{t("operations.fileName")}</th>
                  <th>{t("operations.status")}</th>
                  <th>{t("operations.createdAt")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td>{t(`operations.${attachment.attachmentType}`)}</td>
                    <td>{attachment.fileName}</td>
                    <td>{attachment.scanStatus}</td>
                    <td>{formatDateTime(attachment.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="order-detail-section order-detail-wide">
          <div className="history-heading">
            <h2>{t("operations.historyAudit")}</h2>
            <select
              aria-label={t("operations.historyFilter")}
              onChange={(event) => setHistoryFilter(event.target.value)}
              value={historyFilter}
            >
              <option value="all">{t("operations.allEvents")}</option>
              <option value="status_change">{t("operations.statusChanges")}</option>
              <option value="driver_assignment">{t("operations.driverAssignments")}</option>
              <option value="financial_change">{t("operations.financialChanges")}</option>
              <option value="attachment">{t("operations.attachments")}</option>
              <option value="user_action">{t("operations.userActions")}</option>
              <option value="system_action">{t("operations.systemActions")}</option>
            </select>
          </div>
          <div className="history-list">
            {events.map((event) => (
              <article key={event.id}>
                <span className="history-dot" />
                <div>
                  <strong>{auditEventTitle(event, t)}</strong>
                  <p className="history-change">
                    <span className="history-old">
                      {formatAuditValue(event.fieldName, event.previousValue, t, locale)}
                    </span>
                    <span aria-hidden="true"> → </span>
                    <span className="history-new">
                      {formatAuditValue(event.fieldName, event.newValue, t, locale)}
                    </span>
                  </p>
                  <small>
                    {event.actor} · {event.actorRole} · {t(`operations.sources.${event.source}`)} ·{" "}
                    {formatDateTime(event.occurredAt, locale)}
                  </small>
                  {event.reason === null ? null : (
                    <p>
                      {t("operations.reason")}: {event.reason}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
        <div className="order-detail-section order-detail-wide">
          {/* Accounting is a separate module; this panel is additive and
              renders nothing for a User without Accounting access.

              A no-impact Order never raises an Accounting Event, so there is no
              Journal to link to. The panel is replaced by a plain statement
              rather than left to render an empty result that would read as a
              missing record — and no link is offered that could not resolve. */}
          {showsAccountingRelatedRecords(detail) ? null : (
            <section>
              <h2>{t("operations.accountingColumn")}</h2>
              <p>{t("operations.noAccountingRequiredExplanation")}</p>
            </section>
          )}
          {!showsAccountingRelatedRecords(detail) ? null : (
          <AccountingRelatedPanel
            api={api}
            companyId={companyId}
            onNavigate={(path) => onNavigate?.(path)}
            permissions={permissions}
            sourceId={detail.id}
            sourceType="order"
          />
          )}
        </div>
      </main>
      {editOpen ? (
        <EditOrderDialog
          api={api}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await load();
          }}
          orderId={detail.id}
          orderNumber={detail.orderNumber}
        />
      ) : null}
      {holdOpen ? (
        <ReasonDialog
          busy={statusBusy}
          label={t("operations.holdReasonPrompt")}
          onClose={() => setHoldOpen(false)}
          onSubmit={(reason) => {
            setStatusBusy(true);
            void api
              .patch(`operations/orders/${detail.id}/status`, {
                reason: reason.trim(),
                status: "hold",
              })
              .then(async () => {
                setHoldOpen(false);
                await load();
              })
              .catch((requestError) =>
                setError(message(requestError, t("operations.statusUpdateFailed"))),
              )
              .finally(() => setStatusBusy(false));
          }}
          title={t("operations.actions.hold")}
        />
      ) : null}
      {collectionError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {collectionError}
        </div>
      )}
      {settlementError === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {settlementError}
        </div>
      )}
      {collectOpen ? (
        <CollectMoneyDialog
          api={api}
          drivers={
            detail.assignedDriverId === null
              ? []
              : [
                  {
                    activeOrders: 0,
                    code: "",
                    deliveredOrders: 0,
                    id: detail.assignedDriverId,
                    mobileNumber: detail.assignedDriverMobile ?? "",
                    name: detail.assignedDriverName ?? "",
                    pendingCashOrders: 0,
                    status: "active",
                    type: "",
                  },
                ]
          }
          onClose={() => setCollectOpen(false)}
          onComplete={async () => {
            setCollectOpen(false);
            await load();
          }}
          selection={singleSelection(detail.id)}
        />
      ) : null}
      {viewCollectionId === undefined ? null : (
        <DriverCollectionDetailDialog
          api={api}
          {...(detail.serialNumber === null
            ? {}
            : { highlightOrderSerialNumber: detail.serialNumber })}
          onClose={() => setViewCollectionId(undefined)}
          onReversed={async () => {
            setViewCollectionId(undefined);
            await load();
          }}
          reconciliationId={viewCollectionId}
        />
      )}
      {viewSettlementId === undefined ? null : (
        <SettlementDetailDialog
          api={api}
          canReverse={canReverseSettlement}
          canViewReport={canViewSettlementReport}
          onClose={() => setViewSettlementId(undefined)}
          onOpenAccountStatement={(traderId) => {
            setViewSettlementId(undefined);
            onNavigate?.(
              `/trader-settlements?openStatement=true&statementTraderId=${encodeURIComponent(traderId)}`,
            );
          }}
          onReversed={async () => {
            setViewSettlementId(undefined);
            await load();
          }}
          reportLanguage={reportLanguage}
          settlementId={viewSettlementId}
        />
      )}
    </>
  );
}

function AssignDriverDialog({
  api,
  drivers,
  onClose,
  onComplete,
  selection,
}: {
  api: ApiClient;
  drivers: readonly OperationsDriver[];
  onClose: () => void;
  onComplete: () => Promise<void>;
  selection: SelectionPayload;
}) {
  const { t } = useTranslation();
  const driverOptions = Array.isArray(drivers) ? drivers : [];
  const [driverId, setDriverId] = useState("");
  const [preview, setPreview] = useState<SelectionSummary>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!driverId) {
      setPreview(undefined);
      return;
    }
    void api
      .post<SelectionSummary>("operations/orders/bulk-assign/preview", {
        ...selection,
        driverIdToAssign: driverId,
      })
      .then(setPreview)
      .catch((requestError: unknown) =>
        setError(
          requestError instanceof Error ? requestError.message : t("operations.bulkActionFailed"),
        ),
      );
  }, [api, driverId, selection, t]);
  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.post("operations/orders/bulk-assign", { ...selection, driverIdToAssign: driverId });
      await onComplete();
    } catch (requestError) {
      setError(message(requestError, t("operations.bulkActionFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.assignDriver")}
      titleId="assign-driver-title"
    >
      <label className="field">
        <span>{t("operations.driver")}</span>
        <select autoFocus onChange={(event) => setDriverId(event.target.value)} value={driverId}>
          <option value="">{t("operations.selectDriver")}</option>
          {driverOptions.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.code} - {driver.name}
            </option>
          ))}
        </select>
      </label>
      {preview === undefined ? null : <ActionPreview preview={preview} />}
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={!driverId || saving || preview?.eligibleCount === 0}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.working") : t("operations.assignDriver")}
        </button>
      </div>
    </Modal>
  );
}

function BulkStatusDialog({
  api,
  onClose,
  onComplete,
  selection,
}: {
  api: ApiClient;
  onClose: () => void;
  onComplete: () => Promise<void>;
  selection: SelectionPayload;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState("out_for_delivery");
  const [reason, setReason] = useState("");
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const reasonRequired = ["hold", "cancelled", "returned_to_branch", "returned_to_trader"].includes(
    status,
  );
  const submit = async () => {
    if (reasonRequired && !reason.trim()) return;
    setSaving(true);
    try {
      await api.post("operations/orders/bulk-status", {
        ...selection,
        allowPartial: partial,
        reason: reason.trim() || undefined,
        targetStatus: status,
      });
      await onComplete();
    } catch (requestError) {
      setError(message(requestError, t("operations.bulkActionFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.changeStatus")}
      titleId="bulk-status-title"
    >
      <label className="field">
        <span>{t("operations.deliveryStatus")}</span>
        <select autoFocus onChange={(event) => setStatus(event.target.value)} value={status}>
          {bulkTargetStatuses.map((value) => (
            <option key={value} value={value}>
              {t(`statuses.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t("operations.reason")}</span>
        <textarea
          onChange={(event) => setReason(event.target.value)}
          required={reasonRequired}
          value={reason}
        />
      </label>
      <label className="checkbox-field">
        <input
          checked={partial}
          onChange={(event) => setPartial(event.target.checked)}
          type="checkbox"
        />
        <span>{t("operations.processEligibleOnly")}</span>
      </label>
      {error === undefined ? null : <div className="alert alert-error">{error}</div>}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={saving || (reasonRequired && !reason.trim())}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.working") : t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}

interface CollectPreview {
  readonly companyFees: string;
  readonly difference: string;
  readonly driverId: string;
  readonly expenseTotal: string;
  readonly grossCollections: string;
  readonly netAmountExpected: string;
  readonly orderCount: number;
  readonly paymentTotal: string;
  readonly traderCount: number;
  readonly traderPayable: string;
  readonly warnings: readonly string[];
}
interface CollectExpenseType {
  readonly id: string;
  readonly name: string;
}

// Collect the cash for the selected delivered orders from their driver, in one reconciliation.
// The backend requires every selected order to belong to the same driver.
function CollectMoneyDialog({
  api,
  drivers,
  onClose,
  onComplete,
  selection,
}: {
  api: ApiClient;
  drivers: readonly OperationsDriver[];
  onClose: () => void;
  onComplete: () => Promise<void>;
  selection: SelectionPayload;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const branding = useContext(CompanyBrandingContext);
  const reportLanguage = branding?.textLanguage === "ar" ? "ar" : "en";
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "visa">("cash");
  const [expenses, setExpenses] = useState<
    readonly { amount: string; expenseTypeId: string; reason: string }[]
  >([]);
  // Never pre-filled from Net Expected: the operator enters what the Driver actually
  // handed over, so the Difference correctly reads negative until they do.
  const [cash, setCash] = useState("");
  const [expenseTypes, setExpenseTypes] = useState<readonly CollectExpenseType[]>([]);
  const [preview, setPreview] = useState<CollectPreview>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState<{
    driverName: string;
    grossCollections: string;
    orderCount: number;
    paymentMethod: "cash" | "visa";
    reconciliationId: string;
    reconciliationNumber: string;
  }>();
  const pdf = useReconciliationPdfActions(api);
  const [pdfError, setPdfError] = useState<string>();
  const idempotency = useIdempotencyKey();

  // Reason is optional; rows still being filled in (no type or amount yet) are ignored.
  const filledExpenses = expenses.filter((row) => row.expenseTypeId !== "" && row.amount !== "");
  const cleanExpenses = useMemo(
    () =>
      filledExpenses.map((row) => ({
        amount: Number(twoDecimals(row.amount)),
        expenseTypeId: row.expenseTypeId,
        reason: row.reason.trim(),
      })),
    // filledExpenses is rebuilt every render; key the memo on its serialized
    // value so it only recomputes when an expense's content actually changes.
    [JSON.stringify(filledExpenses)],
  );

  useEffect(() => {
    void api
      .get<readonly CollectExpenseType[]>("operations/cash/expense-types")
      .then(setExpenseTypes)
      .catch(() => undefined);
  }, [api]);

  // Preview depends on the selection and expenses only (payments don't change the net expected),
  // so typing the cash amount doesn't re-hit the server.
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .post<CollectPreview>("operations/cash/reconciliations/preview", {
          ...selection,
          expenses: cleanExpenses,
          payments: [],
        })
        .then((result) => {
          if (!active) return;
          setPreview(result);
          setError(undefined);
        })
        .catch((requestError) => {
          if (!active) return;
          setPreview(undefined);
          setError(message(requestError, t("operations.reconciliationInvalid")));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, cleanExpenses, selection, t]);

  const driverName = drivers.find((driver) => driver.id === preview?.driverId)?.name;
  const netExpected = preview === undefined ? 0 : Number(preview.netAmountExpected);
  const difference = twoDecimals(Number(twoDecimals(cash || 0)) - netExpected);
  const confirmPayload = {
    ...selection,
    // Authoritative Cash/Visa method for the whole collection (§6), stored on the collection
    // and each Order. The tender amount is recorded as the money received.
    collectionPaymentMethod: paymentMethod,
    expenses: cleanExpenses,
    payments:
      cash.trim() === "" ? [] : [{ amount: Number(twoDecimals(cash)), paymentMethod: "cash" }],
  };
  const fingerprint = `${paymentMethod}|${materialFingerprint({
    excludedOrderIds: "excludedOrderIds" in selection ? selection.excludedOrderIds : [],
    expenses: cleanExpenses.map((row) => ({ ...row, amount: String(row.amount) })),
    orderIds: "orderIds" in selection ? selection.orderIds : [],
    payments: confirmPayload.payments.map((row) => ({ ...row, amount: String(row.amount) })),
    selectionMode: selection.selectionMode,
  })}`;

  const submit = async () => {
    if (preview === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await api.post<{
        reconciliationId: string;
        reconciliationNumber: string;
      }>("operations/cash/reconciliations/selected", confirmPayload, {
        "X-Idempotency-Key": idempotency.keyFor(fingerprint),
      });
      idempotency.reset();
      // Keep the dialog open on success so the operator can preview/print/download
      // the confirmed collection; the list is refreshed when they close via Done.
      // Uses the reconciliation ID the backend just returned — never the number
      // alone — for every subsequent report/PDF request.
      setConfirmed({
        driverName: driverName ?? "",
        grossCollections: preview.grossCollections,
        orderCount: preview.orderCount,
        paymentMethod,
        reconciliationId: result.reconciliationId,
        reconciliationNumber: result.reconciliationNumber,
      });
    } catch (requestError) {
      setError(message(requestError, t("operations.reconciliationFailed")));
    } finally {
      setSaving(false);
    }
  };

  const openConfirmedPdf = async (mode: PdfAction) => {
    if (confirmed === undefined) return;
    setPdfError(undefined);
    const requestError = await pdf.run(
      `operations/cash/reconciliations/${confirmed.reconciliationId}/pdf?language=${reportLanguage}`,
      `Driver-Collection-${confirmed.reconciliationNumber}.pdf`,
      mode,
    );
    if (requestError !== undefined) {
      setPdfError(message(requestError, t("operations.pdfGenerationFailed")));
    }
  };

  const canSubmit =
    preview !== undefined &&
    preview.orderCount > 0 &&
    preview.warnings.length === 0 &&
    cash.trim() !== "" &&
    Number(difference) === 0 &&
    !saving;

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.actions.collectMoney")}
      titleId="collect-money-title"
    >
      {confirmed !== undefined ? (
        <div className="reconciliation-success" role="status">
          <p>{t("operations.collectionConfirmed", { number: confirmed.reconciliationNumber })}</p>
          <dl className="reconciliation-summary">
            <div className="detail-line">
              <dt>{t("operations.reconciliationNumber")}</dt>
              <dd>{confirmed.reconciliationNumber}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.driver")}</dt>
              <dd>{confirmed.driverName}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.orders")}</dt>
              <dd>{confirmed.orderCount}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.grossCustomerCollections")}</dt>
              <dd>{formatCurrency(confirmed.grossCollections, "AED", locale)}</dd>
            </div>
            <div className="detail-line">
              <dt>{t("operations.paymentMethod")}</dt>
              <dd>
                {t(
                  `operations.paymentMethod${confirmed.paymentMethod === "cash" ? "Cash" : "Visa"}`,
                )}
              </dd>
            </div>
          </dl>
          {pdfError === undefined ? null : <div className="alert alert-error">{pdfError}</div>}
          <div className="modal-actions">
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("preview")}
              type="button"
            >
              {pdf.busy === "preview" ? t("common.loading") : t("operations.previewReport")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("print")}
              type="button"
            >
              {pdf.busy === "print" ? t("common.loading") : t("common.print")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void openConfirmedPdf("download")}
              type="button"
            >
              {pdf.busy === "download" ? t("common.loading") : t("operations.downloadPdf")}
            </button>
            <button
              className="button button-primary"
              onClick={() => void onComplete()}
              type="button"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : preview === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : (
          <div className="alert alert-error">{error}</div>
        )
      ) : (
        <>
          {preview.warnings.length === 0 ? null : (
            <div className="alert alert-error" role="alert">
              <p>{t("operations.mixedEligibilityWarning")}</p>
              <ul>
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="field">
            <span>{t("operations.paymentMethod")}</span>
            <select
              onChange={(event) => setPaymentMethod(event.target.value as "cash" | "visa")}
              value={paymentMethod}
            >
              <option value="cash">{t("operations.paymentMethodCash")}</option>
              <option value="visa">{t("operations.paymentMethodVisa")}</option>
            </select>
          </label>
          <dl className="reconciliation-summary">
            <div>
              <dt>{t("operations.driver")}</dt>
              <dd>{driverName ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("operations.selectedOrders")}</dt>
              <dd>{preview.orderCount}</dd>
            </div>
            <div>
              <dt>{t("operations.tradersRepresented")}</dt>
              <dd>{preview.traderCount}</dd>
            </div>
            <div>
              <dt>{t("operations.grossCustomerCollections")}</dt>
              <dd>{formatCurrency(preview.grossCollections, "AED", locale)}</dd>
            </div>
            <div>
              <dt>{t("operations.companyFees")}</dt>
              <dd>{formatCurrency(preview.companyFees, "AED", locale)}</dd>
            </div>
            <div>
              <dt>{t("operations.amountDueToTrader")}</dt>
              <dd>{formatCurrency(preview.traderPayable, "AED", locale)}</dd>
            </div>
            <div>
              <dt>{t("operations.expenses")}</dt>
              <dd>{formatCurrency(preview.expenseTotal, "AED", locale)}</dd>
            </div>
            <div>
              <dt>{t("operations.netAmountExpected")}</dt>
              <dd>{formatCurrency(preview.netAmountExpected, "AED", locale)}</dd>
            </div>
            <div>
              <dt>{t("operations.difference")}</dt>
              <dd>{formatCurrency(difference, "AED", locale)}</dd>
            </div>
          </dl>
          <div className="collect-expenses">
            <div className="collect-expenses-head">
              <span>{t("operations.expenses")}</span>
              <button
                className="button button-link"
                onClick={() =>
                  setExpenses((current) => [
                    ...current,
                    { amount: "", expenseTypeId: "", reason: "" },
                  ])
                }
                type="button"
              >
                {t("operations.addExpense")}
              </button>
            </div>
            {expenses.map((row, index) => (
              <div className="collect-expense-row collect-expense-row-reason" key={index}>
                <select
                  onChange={(event) =>
                    setExpenses((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, expenseTypeId: event.target.value } : item,
                      ),
                    )
                  }
                  value={row.expenseTypeId}
                >
                  <option value="">{t("operations.expenseType")}</option>
                  {expenseTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
                <input
                  className="no-spinner"
                  inputMode="decimal"
                  min="0.01"
                  onChange={(event) =>
                    setExpenses((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, amount: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder="0.00"
                  step="0.01"
                  type="number"
                  value={row.amount}
                />
                <input
                  onChange={(event) =>
                    setExpenses((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, reason: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder={t("operations.expenseReasonPlaceholder")}
                  value={row.reason}
                />
                <button
                  aria-label={t("common.remove")}
                  className="icon-button"
                  onClick={() =>
                    setExpenses((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <label className="field required-field">
            <span>{t("operations.actualReceived")}</span>
            <input
              className="no-spinner"
              inputMode="decimal"
              min="0"
              onChange={(event) => setCash(event.target.value)}
              step="0.01"
              type="number"
              value={cash}
            />
          </label>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={!canSubmit}
              onClick={() => void submit()}
              type="button"
            >
              {saving ? t("common.working") : t("operations.actions.collectMoney")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function DriverShipmentManifestDialog({
  api,
  onClose,
  selection,
}: {
  api: ApiClient;
  onClose: () => void;
  selection: ManifestSelectionPayload;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const branding = useContext(CompanyBrandingContext);
  const reportLanguage = branding?.textLanguage === "ar" ? "ar" : "en";
  const [preview, setPreview] = useState<{
    header: { driverMobile: string; driverName: string; orderCount: number };
    summary: { totalCod: string; totalOrders: number; totalPackages: number };
  }>();
  const [error, setError] = useState<string>();
  const pdf = useReconciliationPdfActions(api);

  const loadPreview = useCallback(async () => {
    setError(undefined);
    try {
      const result = await api.post<{
        header: { driverMobile: string; driverName: string; orderCount: number };
        summary: { totalCod: string; totalOrders: number; totalPackages: number };
      }>("operations/cash/driver-shipment-manifest/data", selection);
      setPreview(result);
    } catch (requestError) {
      setError(message(requestError, t("operations.manifestPreviewFailed")));
    }
  }, [api, selection, t]);

  useEffect(() => {
    let active = true;
    void api
      .post<{
        header: { driverMobile: string; driverName: string; orderCount: number };
        summary: { totalCod: string; totalOrders: number; totalPackages: number };
      }>("operations/cash/driver-shipment-manifest/data", selection)
      .then((result) => active && setPreview(result))
      .catch((requestError) =>
        active ? setError(message(requestError, t("operations.manifestPreviewFailed"))) : undefined,
      );
    return () => {
      active = false;
    };
  }, [api, selection, t]);

  const filename = `Driver-Manifest-${(preview?.header.driverName ?? "").replaceAll(/[^A-Za-z0-9]+/g, "-")}.pdf`;

  const run = async (mode: PdfAction) => {
    setError(undefined);
    const requestError = await pdf.run(
      `operations/cash/driver-shipment-manifest/pdf?language=${reportLanguage}`,
      filename,
      mode,
      selection,
    );
    if (requestError !== undefined) {
      setError(message(requestError, t("operations.manifestPreviewFailed")));
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.actions.printManifest")}
      titleId="driver-manifest-title"
    >
      {preview === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : (
          <>
            <div className="alert alert-error">{error}</div>
            <div className="modal-actions">
              <button onClick={() => void loadPreview()} type="button">
                {t("common.refresh")}
              </button>
              <button className="button button-primary" onClick={onClose} type="button">
                {t("common.close")}
              </button>
            </div>
          </>
        )
      ) : (
        <>
          <dl className="reconciliation-summary">
            <div>
              <dt>{t("operations.driver")}</dt>
              <dd>{preview.header.driverName}</dd>
            </div>
            <div>
              <dt>{t("operations.selectedOrders")}</dt>
              <dd>{preview.header.orderCount}</dd>
            </div>
            <div>
              <dt>{t("operations.manifestTotalCod")}</dt>
              <dd>{formatCurrency(preview.summary.totalCod, "AED", locale)}</dd>
            </div>
            <div>
              <dt>{t("operations.manifestTotalPackages")}</dt>
              <dd>{preview.summary.totalPackages}</dd>
            </div>
          </dl>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <div className="modal-actions">
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void run("preview")}
              type="button"
            >
              {pdf.busy === "preview" ? t("common.loading") : t("operations.previewReport")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void run("print")}
              type="button"
            >
              {pdf.busy === "print" ? t("common.loading") : t("common.print")}
            </button>
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void run("download")}
              type="button"
            >
              {pdf.busy === "download" ? t("common.loading") : t("operations.downloadPdf")}
            </button>
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function FilterSelect({
  children,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useTranslation();
  return (
    <label className="filter-select">
      <span className="sr-only">{label}</span>
      <select aria-label={label} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">{t("operations.allLabel", { label })}</option>
        {children}
      </select>
    </label>
  );
}
type OrderStatusKey =
  | "new"
  | "in_branch"
  | "assigned_to_driver"
  | "out_for_delivery"
  | "hold"
  | "delivered"
  | "returned_to_branch"
  | "returned_to_trader"
  | "money_collected"
  | "money_sent_to_trader"
  | "money_received_by_trader"
  | "settlement_reversed"
  | "closed"
  | "cancelled";

// Delivery, cash and settlement remain independent controls in storage. This is the
// single operator-facing status, ordered by the latest meaningful lifecycle event.
function deriveOrderStatus(order: OperationsOrder): { key: OrderStatusKey; tone: string } {
  const status = order.deliveryStatus;
  if (status === "cancelled") return { key: "cancelled", tone: "disabled" };
  if (status === "closed") return { key: "closed", tone: "active" };
  if (order.traderSettlementStatus === "reversed") {
    return { key: "settlement_reversed", tone: "warning" };
  }
  if (order.traderSettlementStatus === "money_received_by_trader") {
    return { key: "money_received_by_trader", tone: "active" };
  }
  if (order.traderSettlementStatus === "money_sent_to_trader") {
    return { key: "money_sent_to_trader", tone: "progress" };
  }
  if (order.driverReconciliationStatus === "reconciled") {
    return { key: "money_collected", tone: "progress" };
  }
  return { key: status as OrderStatusKey, tone: status === "hold" ? "warning" : "neutral" };
}

function orderStatusLabel(t: TFunction, key: OrderStatusKey): string {
  return key === "money_collected" ||
    key === "money_sent_to_trader" ||
    key === "money_received_by_trader" ||
    key === "settlement_reversed"
    ? t(`operations.orderStatusLabels.${key}`)
    : t(`statuses.${key}`);
}

// The true Delivery Status, on its own — never overridden by a later financial
// event (Money Collected, Money Sent to Trader, ...). Delivery, Driver
// Collection and Trader Settlement are three independent dimensions in
// storage and must stay visibly independent here too.
function DeliveryStatusBadge({
  large = false,
  order,
}: {
  large?: boolean;
  order: OperationsOrder;
}) {
  const { t } = useTranslation();
  const tone = order.deliveryStatus === "cancelled" ? "disabled" : "neutral";
  return (
    <span className={`status status-${tone}${large ? " order-status-large" : ""}`}>
      {t(`statuses.${order.deliveryStatus}`)}
    </span>
  );
}

/**
 * Whether this Order will ever reach the ledger.
 *
 * Renders nothing when the API did not classify the Order — an older build, or
 * a payload that predates the field. Showing "No Accounting Required" on a
 * missing value would be a confident answer to a question nobody answered.
 */
function OrderAccountingBadge({ order }: { order: OperationsOrder }) {
  const { t } = useTranslation();
  const status = orderAccountingStatus(order);
  if (status === null) return null;
  return (
    <span
      className={`status status-${status === "not_applicable" ? "disabled" : "neutral"}`}
      data-order-accounting-status={status}
    >
      {t(`operations.accountingStatuses.${status}`)}
    </span>
  );
}


/**
 * Confirm a delivery-status change.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * The direct transitions -- Mark Delivered, Mark Out for Delivery, Mark In
 * Branch, Close -- previously wrote straight from the row menu with no
 * confirmation step. There was therefore no dialog for a smart next action to
 * open, and no field for it to suggest a status in: the only two outcomes
 * available to a deep link were "open a menu" or "PATCH the Order", and the
 * second is an automatic status change.
 *
 * This is the missing confirmation step. It writes nothing itself -- `onConfirm`
 * is the caller's existing `patchStatus`, unchanged -- and it offers only the
 * transitions `availableActions()` already judged lawful for this Order. The
 * backend re-checks every one of them.
 *
 * The reason-carrying transitions (Hold, Cancel, Return) keep their existing
 * `ReasonDialog`; this does not replace or duplicate it.
 */
function ChangeStatusDialog({
  busy,
  onClose,
  onConfirm,
  options,
  orderNumber,
  suggestedStatus,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (status: string) => void;
  /** Lawful targets only, already filtered by status and permission. */
  options: readonly { readonly label: string; readonly status: string }[];
  orderNumber: string;
  suggestedStatus?: string | undefined;
}) {
  const { t } = useTranslation();
  const selectRef = useRef<HTMLSelectElement>(null);
  const titleId = useId();
  // The suggestion is a DEFAULT, not a decision: it is applied only when it is
  // one of the lawful options, so an unlawful or stale suggestion in a URL
  // silently falls back to the first legitimate transition.
  const suggested =
    suggestedStatus !== undefined && options.some((option) => option.status === suggestedStatus)
      ? suggestedStatus
      : (options[0]?.status ?? "");
  const [status, setStatus] = useState(suggested);

  // Focused rather than programmatically expanded: opening a native <select>
  // from script is not something browsers support consistently, and a focused
  // control with the right value already chosen is the honest equivalent.
  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.changeStatusTitle")}
      titleId={titleId}
    >
      <p className="form-hint">
        {t("operations.changeStatusPrompt")} <bdi dir="ltr">{orderNumber}</bdi>
      </p>
      <label>
        {t("operations.deliveryStatus")}
        <select
          disabled={busy}
          onChange={(event) => setStatus(event.target.value)}
          ref={selectRef}
          value={status}
        >
          {options.map((option) => (
            <option key={option.status} value={option.status}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={busy || status === ""}
          onClick={() => onConfirm(status)}
          type="button"
        >
          {t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}

function FinancialStatusCell({
  order,
  onNavigate,
  permissions,
}: {
  onNavigate: (path: string) => void;
  order: OperationsOrder;
  permissions: readonly string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="financial-status-cell">
      {/* Server-derived workflow guidance. It sits in the existing financial
          status area rather than in a new column, so no row grows wider and
          the checkbox, row menu and selection behaviour are untouched. */}
      {order.workflowGuidance === undefined ? null : (
        <OrderWorkflowIndicator
          guidance={order.workflowGuidance}
          onNavigate={onNavigate}
          orderNumber={order.orderNumber}
          permissions={permissions}
          statuses={{
            /* The ledger's own state where the server supplied it. The old
               expression only predicted whether an Event SHOULD exist, so a
               posted Order still read as "Posting expected". */
            accounting: order.accountingRequired
              ? (order.accountingState ??
                (order.deliveryStatus === "delivered" ? "expected" : "pending"))
              : "not_applicable",
            delivery: order.deliveryStatus,
            driverCash: order.driverReconciliationStatus,
            return: order.returnStatus ?? null,
            settlement: order.traderSettlementStatus,
          }}
        />
      )}
      <span>
        <span className="financial-status-label">{t("operations.driverCashShortLabel")}: </span>
        <DriverCashStatusLabel value={order.driverReconciliationStatus} />
      </span>
      {order.traderSettlementStatus === "not_eligible" ? null : (
        <span data-trader-settlement-status={order.traderSettlementStatus}>
          <span className="financial-status-label">
            {t("operations.traderSettlementShortLabel")}:{" "}
          </span>
          {t(`statuses.${order.traderSettlementStatus}`)}
        </span>
      )}
      {order.outsourcedDriverFeeStatus === "not_required" ? null : (
        <span data-outsourced-driver-fee-status={order.outsourcedDriverFeeStatus}>
          <span className="financial-status-label">
            {t("operations.outsourcedDriverFeeShortLabel")}:{" "}
          </span>
          {t(`operations.outsourcedDriverFeeStatuses.${order.outsourcedDriverFeeStatus}`, {
            defaultValue: order.outsourcedDriverFeeStatus,
          })}
        </span>
      )}
    </div>
  );
}

/** Stable identity: an inline array would re-run the consuming effect. */
const orderDialogs: readonly WorkflowDialog[] = ["change_status", "assign_driver"];

type RowAction =
  | "markInBranch"
  | "assignDriver"
  | "markOutForDelivery"
  | "markDelivered"
  | "hold"
  | "returnToBranch"
  | "returnToTrader"
  | "collectMoney"
  | "viewCollection"
  | "moneyOut"
  | "close"
  | "cancel";

/** Target status -> the reason-carrying action that reaches it. Derived from
    `actionTargetStatus` below so the two can never drift apart. */
const reasonActionForStatus: Readonly<Record<string, RowAction>> = {
  cancelled: "cancel",
  hold: "hold",
  returned_to_branch: "returnToBranch",
  returned_to_trader: "returnToTrader",
};

const actionTargetStatus: Partial<Record<RowAction, string>> = {
  cancel: "cancelled",
  close: "closed",
  markDelivered: "delivered",
  markInBranch: "in_branch",
  markOutForDelivery: "out_for_delivery",
  hold: "hold",
  returnToBranch: "returned_to_branch",
  returnToTrader: "returned_to_trader",
};

function closeEligible(order: OperationsOrder): boolean {
  const status = order.deliveryStatus;
  return (
    ["delivered", "returned_to_trader"].includes(status) &&
    ["reconciled", "not_applicable"].includes(order.driverReconciliationStatus) &&
    ["money_received_by_trader", "not_eligible"].includes(order.traderSettlementStatus) &&
    (status !== "returned_to_trader" || order.returnStatus === "returned_to_trader")
  );
}

function availableActions(order: OperationsOrder): readonly RowAction[] {
  const recon = order.driverReconciliationStatus;
  const settle = order.traderSettlementStatus;
  const cashDone = ["reconciled", "not_applicable"].includes(recon);
  const settleDone = ["money_sent_to_trader", "money_received_by_trader", "not_eligible"].includes(
    settle,
  );
  const base = ((): readonly RowAction[] => {
    switch (order.deliveryStatus) {
      case "new":
        return ["markInBranch", "assignDriver", "hold", "cancel"];
      case "in_branch":
        return ["assignDriver", "cancel"];
      case "assigned_to_driver":
        return ["markOutForDelivery", "hold", "cancel"];
      case "out_for_delivery":
        return ["markDelivered", "hold", "returnToBranch", "cancel"];
      case "hold":
        return [
          ...(order.assignedDriverId === null ? (["assignDriver"] as const) : []),
          ...(order.assignedDriverId === null ? [] : (["markOutForDelivery"] as const)),
          "markDelivered",
          "returnToTrader",
          "cancel",
        ];
      case "delivered":
        return [
          ...(cashDone ? [] : (["collectMoney"] as const)),
          ...(settleDone ? [] : (["moneyOut"] as const)),
          "close",
        ];
      case "returned_to_branch":
        return ["returnToTrader"];
      case "returned_to_trader":
        return [...(settleDone ? [] : (["moneyOut"] as const)), "close"];
      default:
        return [];
    }
  })();
  // A reconciled Order keeps its Driver Collection report reachable regardless
  // of later delivery-status moves (e.g. Delivered → Closed) — the money event
  // already happened and outlives the delivery lifecycle it happened during.
  return recon === "reconciled" ? [...base, "viewCollection"] : base;
}

function singleSelection(orderId: string): SelectionPayload {
  return { ...initialFilters, orderIds: [orderId], selectionMode: "ids" };
}

function OrderRowActions({
  api,
  drivers,
  onChanged,
  onNavigate,
  order,
  permissions,
  workflowRequest,
  onWorkflowRequestIneligible,
  onWorkflowRequestConsumed,
}: {
  api: ApiClient;
  drivers: readonly OperationsDriver[];
  onChanged: () => Promise<void>;
  onNavigate: (path: string) => void;
  order: OperationsOrder;
  permissions: readonly string[];
  /** Reported when the requested action is no longer lawful for this Order. */
  onWorkflowRequestIneligible?: (() => void) | undefined;
  /** Reported once the request has been acted on, so it is never replayed. */
  onWorkflowRequestConsumed?: (() => void) | undefined;
  /** A smart next action asking THIS row to open one of its dialogs. */
  workflowRequest?: { readonly dialog: string; readonly suggestedStatus: string | null } | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reasonFor, setReasonFor] = useState<RowAction>();
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [suggestedStatus, setSuggestedStatus] = useState<string>();
  const [viewCollectionId, setViewCollectionId] = useState<string>();
  const [viewCollectionBusy, setViewCollectionBusy] = useState(false);
  /** The request object already acted on, so a re-render cannot replay it. */
  const workflowRequestHandled = useRef<object | null>(null);
  const canAssign =
    permissions.includes("orders.assign_driver") || permissions.includes("users_roles.manage");
  const canUpdateStatus =
    permissions.includes("orders.update_delivery_status") ||
    permissions.includes("users_roles.manage");
  const canReconcile =
    permissions.includes("reconciliations.create") || permissions.includes("users_roles.manage");
  const canSettle =
    permissions.includes("settlements.create") || permissions.includes("users_roles.manage");
  const actions = availableActions(order).filter((action) =>
    action === "assignDriver"
      ? canAssign
      : action === "collectMoney"
        ? canReconcile
        : action === "moneyOut"
          ? canSettle
          : canUpdateStatus,
  );
  const detailsPath = `/orders/${encodeURIComponent(order.orderNumber)}`;

  const patchStatus = async (status: string, reason?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`operations/orders/${order.id}/status`, {
        reason: reason?.trim() ? reason.trim() : undefined,
        status,
      });
      setOpen(false);
      setReasonFor(undefined);
      await onChanged();
    } catch (requestError) {
      setError(message(requestError, t("operations.statusUpdateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const openViewCollection = async () => {
    setViewCollectionBusy(true);
    setError(undefined);
    try {
      const link = await api.get<
        { reconciliationId: string; reconciliationNumber: string } | undefined
      >(`operations/orders/${order.id}/driver-collection`);
      if (link === undefined) {
        setError(t("operations.noLinkedCollection"));
        return;
      }
      setViewCollectionId(link.reconciliationId);
    } catch (requestError) {
      setError(message(requestError, t("operations.detailLoadFailed")));
    } finally {
      setViewCollectionBusy(false);
    }
  };

  /* Only transitions `availableActions()` already allows for this Order and
     this user, and only the ones that carry no reason prompt -- Hold, Cancel
     and the Returns keep their existing ReasonDialog. */
  const statusOptions = actions
    .filter((action) => actionTargetStatus[action] !== undefined)
    .filter((action) => !["hold", "cancel", "returnToBranch", "returnToTrader"].includes(action))
    .map((action) => ({
      label: t(`operations.actions.${action}`),
      status: actionTargetStatus[action] as string,
    }));

  /* A smart next action asking this row to open a dialog. Permission and
     lawfulness are re-checked here: `statusOptions` is empty when the user
     cannot update status or the transition is not available, and the dialog is
     then never opened. */
  useEffect(() => {
    if (workflowRequest === undefined) return;
    /* Acted on exactly once per request, whatever the outcome.
       This effect re-runs whenever the list re-renders -- including the reload
       that follows a successful status change. Without this guard the dialog
       reopened itself straight after Confirm, offering the NEXT transition
       (Out for Delivery -> Mark Delivered) as though a second change had been
       asked for. Compared by identity, so a genuinely new request still fires. */
    if (workflowRequestHandled.current === workflowRequest) return;
    workflowRequestHandled.current = workflowRequest;
    onWorkflowRequestConsumed?.();
    if (workflowRequest.dialog === "assign_driver") {
      if (canAssign) setAssignOpen(true);
      return;
    }
    if (workflowRequest.dialog !== "change_status") return;
    if (!canUpdateStatus) return;

    /* Two different dialogs answer to `change_status`.

       Hold, Cancel and the two Returns REQUIRE a reason, and the existing
       `ReasonDialog` already owns that. The direct transitions do not, and use
       `ChangeStatusDialog`. Routing on the suggested status keeps one deep-link
       parameter for both rather than inventing a second `openDialog` value that
       would mean almost the same thing. */
    const suggested = workflowRequest.suggestedStatus;
    if (suggested !== null) {
      const reasonAction = reasonActionForStatus[suggested];
      if (reasonAction !== undefined) {
        /* Eligibility comes from `actions` -- the SAME list the row menu is
           built from, already filtered by lifecycle and permission. An Order
           that is no longer eligible simply is not in it, so the dialog is not
           forced open. */
        if (!actions.includes(reasonAction)) {
          onWorkflowRequestIneligible?.();
          return;
        }
        setReasonFor(reasonAction);
        return;
      }
    }
    if (statusOptions.length === 0) {
      onWorkflowRequestIneligible?.();
      return;
    }
    if (suggested !== null) setSuggestedStatus(suggested);
    setStatusOpen(true);
    // Requested once per row per arrival; `workflowRequest` is cleared by the
    // workspace after the first consumption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRequest]);

  const perform = (action: RowAction) => {
    setError(undefined);
    if (action === "assignDriver") {
      setOpen(false);
      setAssignOpen(true);
      return;
    }
    if (action === "collectMoney") {
      setOpen(false);
      setCollectOpen(true);
      return;
    }
    if (action === "viewCollection") {
      setOpen(false);
      void openViewCollection();
      return;
    }
    if (action === "moneyOut") {
      onNavigate("/trader-settlements");
      return;
    }
    if (
      action === "hold" ||
      action === "cancel" ||
      action === "returnToBranch" ||
      action === "returnToTrader"
    ) {
      setOpen(false);
      setReasonFor(action);
      return;
    }
    const target = actionTargetStatus[action];
    if (target !== undefined) {
      /* Confirm rather than write. These transitions used to PATCH straight
         from the menu, which left a smart next action nothing to open and no
         safe way to suggest a status. */
      setOpen(false);
      setSuggestedStatus(target);
      setStatusOpen(true);
    }
  };

  return (
    <div className="row-actions">
      <button
        className="icon-button"
        onClick={() => setOpen(true)}
        title={t("operations.rowActions")}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={18} />
      </button>
      {open ? (
        <Modal
          closeLabel={t("common.close")}
          onRequestClose={() => setOpen(false)}
          title={t("operations.rowActions")}
          titleId={`order-actions-${order.id}`}
        >
          <p className="row-actions-heading">
            <strong>{order.orderNumber}</strong>
            <DeliveryStatusBadge order={order} />
          </p>
          <div className="row-actions-list">
            <button
              className="button button-secondary"
              onClick={() => {
                setOpen(false);
                onNavigate(detailsPath);
              }}
              type="button"
            >
              {t("operations.viewDetails")}
            </button>
            {canEditOrder(order.deliveryStatus) ? (
              <button
                className="button button-secondary"
                onClick={() => {
                  setOpen(false);
                  setEditOpen(true);
                }}
                type="button"
              >
                {t("operations.editOrder")}
              </button>
            ) : null}
            {actions.map((action) => {
              const blocked =
                (action === "close" && !closeEligible(order)) ||
                ((action === "markDelivered" || action === "markOutForDelivery") &&
                  order.assignedDriverId === null);
              return (
                <button
                  className="button button-secondary"
                  disabled={busy || blocked}
                  key={action}
                  onClick={() => perform(action)}
                  title={
                    blocked
                      ? action === "markDelivered" || action === "markOutForDelivery"
                        ? action === "markOutForDelivery"
                          ? t("operations.driverRequiredForDispatch")
                          : t("operations.driverRequiredForDelivery")
                        : t("operations.closeBlockedHint")
                      : undefined
                  }
                  type="button"
                >
                  {t(`operations.actions.${action}`)}
                </button>
              );
            })}
          </div>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
        </Modal>
      ) : null}
      {!statusOpen ? null : (
        <ChangeStatusDialog
          busy={busy}
          onClose={() => setStatusOpen(false)}
          onConfirm={(status) => {
            setStatusOpen(false);
            // The existing write path, unchanged.
            void patchStatus(status);
          }}
          options={statusOptions}
          orderNumber={order.orderNumber}
          {...(suggestedStatus === undefined ? {} : { suggestedStatus })}
        />
      )}
      {reasonFor === undefined ? null : (
        <ReasonDialog
          busy={busy}
          label={
            reasonFor === "hold"
              ? t("operations.holdReasonPrompt")
              : reasonFor === "cancel"
                ? t("operations.cancelReasonPrompt")
                : t("operations.returnReasonPrompt")
          }
          onClose={() => setReasonFor(undefined)}
          onSubmit={(reason) => {
            const target = actionTargetStatus[reasonFor];
            if (target !== undefined) void patchStatus(target, reason);
          }}
          title={t(`operations.actions.${reasonFor}`)}
        />
      )}
      {assignOpen ? (
        <AssignDriverDialog
          api={api}
          drivers={drivers}
          onClose={() => setAssignOpen(false)}
          onComplete={async () => {
            setAssignOpen(false);
            await onChanged();
          }}
          selection={singleSelection(order.id)}
        />
      ) : null}
      {editOpen ? (
        <EditOrderDialog
          api={api}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await onChanged();
          }}
          orderId={order.id}
          orderNumber={order.orderNumber}
        />
      ) : null}
      {collectOpen ? (
        <CollectMoneyDialog
          api={api}
          drivers={drivers}
          onClose={() => setCollectOpen(false)}
          onComplete={async () => {
            setCollectOpen(false);
            await onChanged();
          }}
          selection={singleSelection(order.id)}
        />
      ) : null}
      {viewCollectionId === undefined ? null : (
        <DriverCollectionDetailDialog
          api={api}
          {...(order.serialNumber === null
            ? {}
            : { highlightOrderSerialNumber: order.serialNumber })}
          onClose={() => setViewCollectionId(undefined)}
          onReversed={async () => {
            setViewCollectionId(undefined);
            await onChanged();
          }}
          reconciliationId={viewCollectionId}
        />
      )}
      {!viewCollectionBusy ? null : <div className="loading-row">{t("common.loading")}</div>}
    </div>
  );
}

function ReasonDialog({
  busy,
  label,
  onClose,
  onSubmit,
  title,
}: {
  busy: boolean;
  label: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  title: string;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={title}
      titleId="row-reason-title"
    >
      <label className="field">
        <span>{label}</span>
        <textarea autoFocus onChange={(event) => setReason(event.target.value)} value={reason} />
      </label>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={busy || !reason.trim()}
          onClick={() => onSubmit(reason)}
          type="button"
        >
          {busy ? t("common.working") : t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}
const EDITABLE_STATUSES = ["new", "in_branch", "assigned_to_driver", "out_for_delivery"];
function canEditOrder(deliveryStatus: string): boolean {
  return EDITABLE_STATUSES.includes(deliveryStatus);
}

interface EditOrderForm {
  codAmount: string;
  customerAddress: string;
  customerMobileNumber: string;
  customerName: string;
  customerSecondMobileNumber: string;
  notes: string;
  packageCount: string;
  serviceFee: string;
  serviceFeeReason: string;
}

// Edits an order's business fields before delivery. Prefills from the full order detail, and
// only asks for a reason when the service fee is changed (mirrors the create-time governance).
function EditOrderDialog({
  api,
  onClose,
  onSaved,
  orderId,
  orderNumber,
}: {
  api: ApiClient;
  onClose: () => void;
  onSaved: () => Promise<void>;
  orderId: string;
  orderNumber: string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<OperationsOrderDetail>();
  const [form, setForm] = useState<EditOrderForm>();
  const [newTrader, setNewTrader] = useState<OperationsTraderOption>();
  const [newCustomer, setNewCustomer] = useState<CustomerOption>();
  const [customerAddresses, setCustomerAddresses] = useState<readonly Record<string, unknown>[]>(
    [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void api
      .get<OperationsOrderDetail>(`operations/order-details/${encodeURIComponent(orderNumber)}`)
      .then((loaded) => {
        if (!active) return;
        setDetail(loaded);
        setForm({
          codAmount: loaded.codAmount,
          customerAddress: loaded.customerAddress,
          customerMobileNumber: loaded.customerMobileNumber,
          customerName: loaded.customerName,
          customerSecondMobileNumber: loaded.metadata.customerSecondMobileNumber ?? "",
          notes: loaded.metadata.notes ?? "",
          packageCount: String(loaded.metadata.packageCount),
          serviceFee: loaded.serviceFee,
          serviceFeeReason: "",
        });
      })
      .catch((requestError) =>
        active ? setError(message(requestError, t("operations.detailLoadFailed"))) : undefined,
      );
    return () => {
      active = false;
    };
  }, [api, orderNumber, t]);

  const update = (change: Partial<EditOrderForm>) =>
    setForm((current) => (current === undefined ? current : { ...current, ...change }));

  const identityChanged = newTrader !== undefined || newCustomer !== undefined;
  const feeChanged =
    detail !== undefined &&
    form !== undefined &&
    Number(form.serviceFee) !== Number(detail.serviceFee);
  // A reason is only required for a pure fee override (same trader/area). When the trader or
  // customer changes, the fee is re-priced for the new context, so no reason is needed.
  const reasonNeeded = feeChanged && !identityChanged;
  const valid =
    form !== undefined &&
    form.customerName.trim() !== "" &&
    isUaeMobile(form.customerMobileNumber) &&
    (form.customerSecondMobileNumber.trim() === "" ||
      isUaeMobile(form.customerSecondMobileNumber)) &&
    // Address deliberately absent: optional on create, so optional on edit too.
    form.codAmount !== "" &&
    Number(form.codAmount) >= 0 &&
    form.serviceFee !== "" &&
    Number(form.serviceFee) >= 0 &&
    Number(form.packageCount) >= 1 &&
    (!reasonNeeded || form.serviceFeeReason.trim() !== "");

  const submit = async () => {
    if (form === undefined || !valid) return;
    setSaving(true);
    setError(undefined);
    try {
      // Send the fee only when the operator set it, or when nothing about the pricing context
      // changed; on a trader/customer change with an untouched fee, let the server re-price.
      const sendFee = feeChanged || !identityChanged;
      await api.patch(`operations/orders/${orderId}`, {
        ...(newTrader === undefined ? {} : { traderId: newTrader.id }),
        ...(newCustomer === undefined
          ? {}
          : { customerAddressId: newCustomer.addressId, customerId: newCustomer.id }),
        codAmount: Number(form.codAmount),
        customerAddress: form.customerAddress.trim(),
        customerMobileNumber:
          normalizeUaeMobile(form.customerMobileNumber) ?? form.customerMobileNumber.trim(),
        customerName: form.customerName.trim(),
        customerSecondMobileNumber:
          form.customerSecondMobileNumber.trim() === ""
            ? ""
            : (normalizeUaeMobile(form.customerSecondMobileNumber) ??
              form.customerSecondMobileNumber.trim()),
        notes: form.notes,
        packageCount: Number(form.packageCount),
        ...(sendFee ? { serviceFee: Number(form.serviceFee) } : {}),
        serviceFeeReason:
          feeChanged && form.serviceFeeReason.trim() !== ""
            ? form.serviceFeeReason.trim()
            : undefined,
      });
      await onSaved();
    } catch (requestError) {
      setError(message(requestError, t("operations.editOrderFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.editOrder")}
      titleId="edit-order-title"
    >
      {form === undefined ? (
        <div className="loading-row">{t("common.loading")}</div>
      ) : (
        <>
          <div className="form-grid">
            <label className="field form-grid-single">
              <span>{t("operations.trader")}</span>
              <SearchCombobox
                api={api}
                emptyText={t("operations.noTradersFound")}
                getLabel={(option: OperationsTraderOption) => `${option.code} - ${option.nameEn}`}
                label={t("operations.trader")}
                onChange={(selected) => setNewTrader(selected ?? undefined)}
                path="operations/traders/search"
                placeholder={
                  detail === undefined
                    ? t("operations.searchTrader")
                    : `${t("operations.trader")}: ${detail.traderName}`
                }
                value={newTrader}
              />
            </label>
            <label className="field form-grid-single">
              <span>{t("customerConfig.customer")}</span>
              <SearchCombobox
                api={api}
                emptyText={t("customerConfig.noCustomers")}
                getLabel={(option: CustomerOption) =>
                  `${option.code} - ${option.name} - ${option.mobileNumber}`
                }
                label={t("customerConfig.customer")}
                onChange={(selected) => {
                  setNewCustomer(selected ?? undefined);
                  if (selected === undefined) {
                    setCustomerAddresses([]);
                    return;
                  }
                  update({
                    customerAddress: selected.address,
                    customerMobileNumber: selected.mobileNumber,
                    customerName: selected.name,
                    customerSecondMobileNumber: selected.secondMobileNumber ?? "",
                  });
                  void api
                    .get<{ addresses: readonly Record<string, unknown>[] }>(
                      `configuration/customers/${encodeURIComponent(selected.code)}`,
                    )
                    .then((loaded) => setCustomerAddresses(loaded.addresses))
                    .catch(() => setCustomerAddresses([]));
                }}
                path="configuration/customers/search"
                placeholder={
                  detail === undefined
                    ? t("customerConfig.searchPlaceholder")
                    : `${t("customerConfig.customer")}: ${detail.customerName}`
                }
                value={newCustomer}
              />
            </label>
            {newCustomer !== undefined && customerAddresses.length > 1 ? (
              <label className="field form-grid-single">
                <span>{t("customerConfig.addresses")}</span>
                <select
                  onChange={(event) => {
                    const picked = customerAddresses.find(
                      (item) => String(item.id) === event.target.value,
                    );
                    if (picked === undefined) return;
                    const updated: CustomerOption = {
                      ...newCustomer,
                      address: String(picked.address),
                      addressId: String(picked.id),
                      areaCode: String(picked.areaCode),
                      areaId: String(picked.areaId),
                      areaName: String(picked.areaName),
                    };
                    setNewCustomer(updated);
                    update({ customerAddress: updated.address });
                  }}
                  value={newCustomer.addressId}
                >
                  {customerAddresses
                    .filter((item) => Boolean(item.isActive))
                    .map((item) => (
                      <option key={String(item.id)} value={String(item.id)}>
                        {String(item.label ?? item.address)}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span>{t("operations.customerName")}</span>
              <input
                onChange={(event) => update({ customerName: event.target.value })}
                value={form.customerName}
              />
            </label>
            <label className="field">
              <span>{t("operations.mobile")}</span>
              <input
                autoComplete="tel"
                inputMode="tel"
                maxLength={16}
                onChange={(event) => update({ customerMobileNumber: event.target.value })}
                placeholder={t("common.mobilePlaceholder")}
                value={form.customerMobileNumber}
              />
            </label>
            <label className="field">
              <span>{t("operations.secondMobile")}</span>
              <input
                autoComplete="tel"
                inputMode="tel"
                maxLength={16}
                onChange={(event) => update({ customerSecondMobileNumber: event.target.value })}
                placeholder={t("common.mobilePlaceholder")}
                value={form.customerSecondMobileNumber}
              />
            </label>
            <label className="field">
              <span>{t("operations.packages")}</span>
              <input
                className="no-spinner"
                inputMode="numeric"
                min="1"
                onChange={(event) => update({ packageCount: event.target.value })}
                step="1"
                type="number"
                value={form.packageCount}
              />
            </label>
            <label className="field form-grid-single">
              <span>{t("operations.customerAddress")}</span>
              <textarea
                onChange={(event) => update({ customerAddress: event.target.value })}
                value={form.customerAddress}
              />
            </label>
            <label className="field">
              <span>{t("operations.codAmount")}</span>
              <input
                className="no-spinner"
                inputMode="decimal"
                min="0"
                onChange={(event) => update({ codAmount: event.target.value })}
                step="0.01"
                type="number"
                value={form.codAmount}
              />
            </label>
            <label className="field">
              <span>{t("operations.serviceFee")}</span>
              <input
                className="no-spinner"
                inputMode="decimal"
                min="0"
                onChange={(event) => update({ serviceFee: event.target.value })}
                step="0.01"
                type="number"
                value={form.serviceFee}
              />
            </label>
            <label className="field form-grid-single">
              <span>{t("operations.notes")}</span>
              <textarea
                onChange={(event) => update({ notes: event.target.value })}
                value={form.notes}
              />
            </label>
            {feeChanged ? (
              <label className="field form-grid-single">
                <span>{t("operations.serviceFeeReason")}</span>
                <input
                  onChange={(event) => update({ serviceFeeReason: event.target.value })}
                  value={form.serviceFeeReason}
                />
              </label>
            ) : null}
          </div>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button
              className="button button-primary"
              disabled={saving || !valid}
              onClick={() => void submit()}
              type="button"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function DetailSection({
  rows,
  title,
}: {
  rows: readonly (readonly [string, string])[];
  title: string;
}) {
  return (
    <section className="order-detail-section">
      <h2>{title}</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function TrackingButton({ api, detail }: { api: ApiClient; detail: OperationsOrderDetail }) {
  const { t } = useTranslation();
  const [error, setError] = useState(false);
  const create = async () => {
    try {
      const link = await api.post<OperationsTrackingLink>(
        `operations/orders/${detail.id}/tracking-links`,
      );
      window.open(link.url, "_blank", "noopener,noreferrer");
    } catch {
      setError(true);
    }
  };
  return (
    <button
      className="button button-secondary"
      onClick={() => void create()}
      title={error ? t("operations.trackingLinkFailed") : undefined}
      type="button"
    >
      <UserRoundCheck aria-hidden="true" size={18} />
      {t("operations.trackingLink")}
    </button>
  );
}
function ActionPreview({ preview }: { preview: SelectionSummary }) {
  const { t } = useTranslation();
  return (
    <div className="action-preview">
      <strong>{t("operations.eligibleCount", { count: preview.eligibleCount })}</strong>
      {preview.ineligible.length === 0 ? null : (
        <>
          <p>{t("operations.skippedCount", { count: preview.ineligible.length })}</p>
          <ul>
            {preview.ineligible.slice(0, 8).map((item) => (
              <li key={item.orderNumber}>
                {item.orderNumber}: {item.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
function toggleSet(source: Set<string>, value: string): Set<string> {
  const next = new Set(source);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
function updateSet(source: Set<string>, values: readonly string[], remove: boolean): Set<string> {
  const next = new Set(source);
  values.forEach((value) => (remove ? next.delete(value) : next.add(value)));
  return next;
}
interface VisibleOrderGroup {
  readonly key: string;
  readonly label: string;
  readonly orders: readonly OperationsOrder[];
}

function groupVisibleOrders(
  orders: readonly OperationsOrder[],
  grouping: OrderGrouping,
  t: TFunction,
): readonly VisibleOrderGroup[] {
  if (grouping === "") return [];
  const grouped = new Map<string, OperationsOrder[]>();
  for (const order of orders) {
    const visibleStatus = deriveOrderStatus(order).key;
    const key =
      grouping === "status"
        ? `status:${visibleStatus}`
        : order.assignedDriverId === null
          ? "driver:unassigned"
          : `driver:${order.assignedDriverId}`;
    const existing = grouped.get(key) ?? [];
    existing.push(order);
    grouped.set(key, existing);
  }
  const statusOrder = new Map<string, number>(
    visibleOrderStatuses.map((status, index) => [status, index]),
  );
  return [...grouped.entries()]
    .map(([key, groupedOrders]) => ({
      key,
      label:
        grouping === "status"
          ? orderStatusLabel(t, deriveOrderStatus(groupedOrders[0] ?? orders[0]!).key)
          : (groupedOrders[0]?.assignedDriverName ?? t("operations.unassigned")),
      orders: groupedOrders,
    }))
    .sort((left, right) => {
      if (grouping === "status") {
        const leftStatus =
          left.orders[0] === undefined ? "" : deriveOrderStatus(left.orders[0]).key;
        const rightStatus =
          right.orders[0] === undefined ? "" : deriveOrderStatus(right.orders[0]).key;
        return (statusOrder.get(leftStatus) ?? 999) - (statusOrder.get(rightStatus) ?? 999);
      }
      if (left.key === "driver:unassigned") return 1;
      if (right.key === "driver:unassigned") return -1;
      return left.label.localeCompare(right.label);
    });
}

function GroupSelectionCheckbox({
  checked,
  indeterminate,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input aria-label={label} checked={checked} onChange={onChange} ref={ref} type="checkbox" />
  );
}
function money(value: string, locale: "ar" | "en"): string {
  return formatCurrency(value, "AED", locale);
}
function twoDecimals(value: string | number): string {
  return formatMoneyValue(value);
}
function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.details === undefined || error.details.length === 0
      ? error.message
      : `${error.message}\n${error.details.join("\n")}`;
  }
  return error instanceof Error ? error.message : fallback;
}
type AuditEvent = OperationsOrderDetail["events"][number];
type Translate = TFunction;

// Status-valued fields whose raw enum should be rendered through the shared statuses.* vocabulary.
const AUDIT_STATUS_FIELDS = new Set([
  "delivery_status",
  "driver_reconciliation_status",
  "return_status",
  "trader_settlement_status",
]);

function prettifyToken(value: string): string {
  const cleaned = value
    .replace(/^order\./, "")
    .replace(/[._]/g, " ")
    .trim();
  return cleaned.length === 0 ? value : cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Human label for the thing that changed, so the audit answers "what was changed".
function auditFieldLabel(fieldName: string | null, t: Translate): string {
  switch (fieldName) {
    case "assigned_driver_id":
      return t("operations.assignedDriver");
    case "delivery_status":
      return t("operations.deliveryStatus");
    case "driver_reconciliation_status":
      return t("operations.driverCashStatus");
    case "return_status":
      return t("operations.returnStatus");
    case "service_fee":
      return t("operations.serviceFee");
    case "trader_settlement_status":
      return t("operations.settlementStatus");
    default:
      return fieldName === null ? "" : prettifyToken(fieldName);
  }
}

function auditEventTitle(event: AuditEvent, t: Translate): string {
  if (event.eventType === "order.created") return t("operations.audit.orderCreated");
  // Distinct from an override: same field, entirely different decision.
  if (event.eventType === "order.zero_service_fee")
    return t("operations.audit.zeroServiceFee");
  const field = auditFieldLabel(event.fieldName, t);
  return field !== "" ? field : prettifyToken(event.eventType);
}

function auditScalar(
  fieldName: string | null,
  value: string | number,
  t: Translate,
  locale: "ar" | "en",
): string {
  if (typeof value === "string" && AUDIT_STATUS_FIELDS.has(fieldName ?? "")) {
    return t(`statuses.${value}`, { defaultValue: prettifyToken(value) });
  }
  const looksMonetary = fieldName !== null && /fee|amount|cost|cod/i.test(fieldName);
  if (looksMonetary && value !== "") {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) return formatCurrency(String(value), "AED", locale);
  }
  return String(value);
}

// Renders one audit value (old or new). Objects carry the meaningful token (driver name,
// reference number, or resulting status) that the writer stored for the change.
function formatAuditValue(
  fieldName: string | null,
  value: unknown,
  t: Translate,
  locale: "ar" | "en",
): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const statusField = AUDIT_STATUS_FIELDS.has(fieldName ?? "");
    const candidate = statusField
      ? (record.status ?? record.driverName ?? record.name)
      : (record.driverName ??
        record.name ??
        record.reconciliationNumber ??
        record.settlementNumber ??
        record.status);
    if (typeof candidate === "string" || typeof candidate === "number") {
      return auditScalar(fieldName, candidate, t, locale);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    return auditScalar(fieldName, value, t, locale);
  }
  return String(value);
}

const deliveryStatuses = [
  "new",
  "in_branch",
  "assigned_to_driver",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;
const visibleOrderStatuses: readonly OrderStatusKey[] = [
  "new",
  "in_branch",
  "assigned_to_driver",
  "out_for_delivery",
  "hold",
  "delivered",
  "money_collected",
  "money_sent_to_trader",
  "returned_to_branch",
  "returned_to_trader",
  "settlement_reversed",
  "cancelled",
  "closed",
];
// Statuses an operator can push a batch of orders to. Each order is only moved if the
// transition is valid for its current state (enforced server-side); "Assign to driver"
// is excluded because it needs a driver and has its own action.
const bulkTargetStatuses = [
  "in_branch",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;
const cashStatuses = ["not_applicable", "pending", "reconciled", "reversed"] as const;
const settlementStatuses = [
  "not_eligible",
  "unsettled",
  "money_sent_to_trader",
  "money_received_by_trader",
  "reversed",
] as const;
