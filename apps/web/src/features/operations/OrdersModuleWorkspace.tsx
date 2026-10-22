import {
  ArrowLeft,
  CheckSquare,
  FileText,
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
  X,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
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
  OperationsPendingCashOrder,
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
import { useLocation, useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { FilterCombobox } from "../../components/FilterCombobox.js";
import { SearchCombobox } from "../../components/SearchCombobox.js";
import { AreaSelector } from "../configuration/AreaSelector.js";
import { PricingDialog, TraderForm } from "../configuration/TraderConfigurationWorkspace.js";
import {
  type OrderView,
  type OrderViewsMenu,
  orderViewLabel,
} from "../configuration/order-views.js";
import { OrderWhatsAppHistory } from "../configuration/OrderWhatsAppHistory.js";
import { isUaeMobile, normalizeUaeMobile } from "../../domain/uae-mobile.js";
import { formatCurrency, formatDate, formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { CompanyBrandingContext } from "../../app/CompanyBrandingContext.js";
import { AccountingRelatedPanel } from "../accounting/AccountingRelatedPanel.js";
import { localizeName } from "../../localization/localize-name.js";
import { parseMoneyInput, parseNumericInput } from "../../utils/numeric-input.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { useListState } from "../accounting/use-list-state.js";
import {
  orderAccountingStatus,
  orderFeeSource,
  showsAccountingRelatedRecords,
} from "./order-accounting-policy.js";
import { CreateOrderDialog } from "./CreateOrderDialog.js";
import { listPasteHandler } from "./search-list-input.js";
import { DriverCashStatusLabel, useDriverCashStatusLabel } from "./DriverCashStatus.js";
import { OrderWorkflowIndicator } from "./OrderWorkflowIndicator.js";
import { DriverCollectionDetailDialog } from "./DriverCollectionsWorkspace.js";
import { openOrderWaybill, OrderBarcode } from "./OperationsWorkspace.js";
import { type PdfAction, useReconciliationPdfActions } from "./reconciliation-pdf.js";
import { SettlementDetailDialog } from "./TraderSettlementsWorkspace.js";
import {
  hasOrdersListState,
  ordersListStateStorageKey,
  removeOrdersListSearch,
  readOrdersListSnapshot,
  restoreOrdersListSearch,
  writeOrdersListSnapshot,
  type OrdersGroupingDimension,
} from "./orders-list-state-storage.js";

/**
 * `delivery` is a FRONTEND-ONLY view. It is never sent as `quickView`: the
 * backend expresses Delivery Activity through `deliveredOnly`, and sending an
 * unrecognised quick view would silently fall through to the Active predicate.
 */
type QuickView = "active" | "all" | "hold" | "cancelled" | "closed" | "delivery" | "accountant" | "ai";

/** Quick views the backend actually understands. */
const backendQuickViews = new Set(["active", "all", "hold", "cancelled", "closed", "accountant"]);
type OrderGrouping = "" | OrdersGroupingDimension[];

/**
 * The list filters an Orders menu tab stands for. Standard tabs keep their own
 * quick view and send no `viewKey`; Active Orders and custom tabs are resolved
 * by the server from the saved menu, so the client never sends a rule.
 */
function menuViewFilters(view: OrderView): Record<string, string> {
  if (view.key === "active") return { quickView: "active", viewKey: "active" };
  if (view.kind === "custom") return { quickView: "all", viewKey: view.key };
  return { quickView: view.key, viewKey: "" };
}

/** The request that counts one menu tab: page 1, smallest page, total only. */
function menuViewCountQuery(view: OrderView): string {
  const parameters = new URLSearchParams({ page: "1", pageSize: "25" });
  if (view.key === "delivery") {
    parameters.set("deliveredOnly", "true");
  } else if (view.key === "ai") {
    // The AI tab lists all Orders.
    parameters.set("quickView", "all");
  } else {
    for (const [key, value] of Object.entries(menuViewFilters(view))) {
      if (value !== "") parameters.set(key, value);
    }
  }
  return parameters.toString();
}
type BulkAction = "assign" | "carrier" | "manifest" | "reactivate" | "returnedItems" | "status";

/** Goods going back to the Trader: what the Trader Returned Items report accepts. */
function isReturnedToTraderOrder(order: { deliveryStatus: string; returnStatus: string }): boolean {
  return (
    ["cancelled", "returned_to_branch", "returned_to_trader"].includes(order.deliveryStatus) ||
    order.returnStatus === "returned_to_trader"
  );
}

interface OrderFilters {
  areaId: string;
  /* Selecting an Emirate used to narrow only the Area picker and filter
     nothing, so "show me every Order in Sharjah" was impossible without
     choosing each Area in turn. It is a real server-side filter now. */
  emirateId: string;
  dateFrom: string;
  dateTo: string;
  deliveryStatus: string;
  /** Cancellation type filter; offered on the Cancelled tab only. */
  cancellationReason: string;
  internationalCarrierStatus: string;
  driverId: string;
  orderType: string;
  thirdPartyDeliveryCompanyName: string;
  destinationCountryName: string;
  quickView: QuickView;
  /**
   * Orders menu tab, only when the Company's custom menu is on: `active`
   * (statuses from the menu) or a `custom_*` key. Empty on the standard menu,
   * so the request is exactly what it always was.
   */
  viewKey: string;
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
  serialNumber: string;
  traderId: string;
  workflowStep: string;
  /** Orders ready question key (`order-questions.ts`); empty when none. */
  question: string;
  /** Set by the question box only (Driver cash / Trader settlement status). */
  cashStatus: string;
  settlementStatus: string;
}

interface SelectionPayload extends Partial<OrderFilters> {
  excludedOrderIds?: readonly string[];
  orderIds?: readonly string[];
  selectionMode: "filter" | "ids";
}

interface AccountantPayOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly serialNumber: string;
}

const bulkSelectionFilterKeys = [
  "areaId",
  "dateFrom",
  "dateTo",
  "deliveryStatus",
  "internationalCarrierStatus",
  "driverId",
  "orderType",
  "thirdPartyDeliveryCompanyName",
  "destinationCountryName",
  "quickView",
  "search",
  "serialNumber",
  "traderId",
  "workflowStep",
  // "Select all matching" of a ready question selects exactly its answer.
  "question",
  "cashStatus",
  "settlementStatus",
] as const satisfies readonly (keyof OrderFilters)[];

type ManifestSelectionPayload = Partial<OrderFilters> & {
  excludedOrderIds?: readonly string[];
  orderIds?: readonly string[];
  selectionMode: "filter" | "ids";
};

function cleanSelectionPayload(
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
  for (const key of bulkSelectionFilterKeys) {
    if (filters[key] !== "") Object.assign(payload, { [key]: filters[key] });
  }
  return payload;
}

function selectionPayload(
  filters: OrderFilters,
  allMatching: boolean,
  excludedIds: Set<string>,
  selectedIds: Set<string>,
): SelectionPayload {
  return cleanSelectionPayload(filters, allMatching, excludedIds, selectedIds);
}

interface SelectionSummary {
  eligibleCount: number;
  ineligible: readonly { orderNumber: string; reason: string }[];
  selectedAmountToCollect: string;
  selectedCount: number;
}

const initialFilters: OrderFilters = {
  areaId: "",
  emirateId: "",
  dateFrom: "",
  dateTo: "",
  deliveryStatus: "",
  cancellationReason: "",
  internationalCarrierStatus: "",
  driverId: "",
  orderType: "",
  thirdPartyDeliveryCompanyName: "",
  destinationCountryName: "",
  quickView: "active",
  viewKey: "",
  deliveredOnly: "",
  deliveryDateFrom: "",
  deliveryDateTo: "",
  dateMode: "",
  businessDateFrom: "",
  businessDateTo: "",
  referenceNumber: "",
  search: "",
  serialNumber: "",
  traderId: "",
  workflowStep: "",
  question: "",
  cashStatus: "",
  settlementStatus: "",
};

/**
 * Orders ready questions (11 Oct 2026). Same keys, same order and same
 * grouping as `apps/api/src/operations/order-questions.ts`; the API is the
 * truth for what each one matches.
 */
const orderQuestions = [
  { grouping: null, key: "ready_to_close" },
  { grouping: "driver", key: "collect_from_driver" },
  { grouping: "trader", key: "pay_trader" },
  { grouping: "trader", key: "confirm_trader_receipt" },
  { grouping: "trader", key: "trader_owes_fees" },
  { grouping: null, key: "no_driver" },
  { grouping: "driver", key: "out_not_delivered" },
  { grouping: null, key: "on_hold" },
] as const satisfies readonly { grouping: OrdersGroupingDimension | null; key: string }[];

/**
 * An International Order is in its carrier stages only until it is delivered.
 * Once delivered, closed, returned or cancelled, its next step is the normal
 * money workflow (confirm the Trader's receipt, close ...), so the carrier
 * stage must no longer replace it. ORD-000162 (11 Oct 2026): closed, carrier
 * stage still "In Transit", and its "Confirm receipt" step was hidden.
 */
function inCarrierStages(order: {
  readonly deliveryStatus: string;
  readonly orderType?: string | null | undefined;
}) {
  return (
    order.orderType === "gcc_international" &&
    !["delivered", "closed", "returned_to_trader", "cancelled"].includes(order.deliveryStatus)
  );
}

interface OrderQuestionCount {
  readonly amount: string | null;
  readonly count: number;
  readonly key: string;
}

/** `POST operations/orders/ask` (`order-question-ask.ts`). */
interface OrderAskChip {
  readonly field: string;
  readonly filterKeys: readonly string[];
  readonly value: string;
}
interface OrderAskResult {
  readonly chips: readonly OrderAskChip[];
  readonly filters: Readonly<Record<string, string>>;
  readonly notes: readonly {
    readonly candidates: readonly string[];
    readonly field: string;
    readonly value: string;
  }[];
  readonly source: "ai" | "library";
  readonly unsupported: boolean;
}

/** Same permissions as `POST operations/orders/ask` (no Driver self service). */
const orderAskPermissions = [
  "orders.edit_before_processing",
  "orders.assign_driver",
  "orders.update_delivery_status",
  "reconciliations.create",
  "reconciliations.reverse",
  "settlements.create",
  "settlements.reverse",
  "users_roles.manage",
];

/**
 * Favourite questions (11 Oct 2026): a user's own saved questions, kept per
 * Company and user in this browser -- the same place the Orders list already
 * remembers its filters. A favourite is asked again when clicked, so "yesterday"
 * always means yesterday.
 */
const favouriteQuestionsLimit = 30;
/**
 * Ten ready-made favourites every user starts with (Aiman, 11 Oct 2026),
 * stored as `@default:<key>` and shown in the screen's language, so switching
 * Arabic / English never leaves them in the other language. Each user can
 * delete any of them; a deleted one does not come back.
 */
const defaultFavouriteQuestions = [
  "delivered_today",
  "delivered_yesterday",
  "out_for_delivery",
  "cash_with_driver",
  "trader_not_paid",
  "on_hold",
  "no_driver",
  "new_today",
  "returned_this_week",
  "cancelled_this_month",
] as const;
const defaultFavouritePrefix = "@default:";
function favouriteQuestionsKey(scope: { readonly companyId: string; readonly userId: string }) {
  return `blueline.orders.favouriteQuestions.v2.${scope.companyId}.${scope.userId}`;
}
function readFavouriteQuestions(key: string | null): readonly string[] {
  const seeded = defaultFavouriteQuestions.map((item) => `${defaultFavouritePrefix}${item}`);
  if (key === null) return seeded;
  try {
    const stored = window.localStorage.getItem(key);
    // First visit: the ten ready-made questions.
    if (stored === null) return seeded;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string" && item.trim() !== "")
          .slice(0, favouriteQuestionsLimit)
      : [];
  } catch {
    return seeded;
  }
}
const sameQuestion = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** The value of one "Understood as" chip, in the user's language. */
function orderAskChipValue(chip: OrderAskChip, t: TFunction): string {
  const each = (value: string, prefix: string) =>
    value
      .split(",")
      .map((item) => t(`${prefix}.${item}`, { defaultValue: item }))
      .join(", ");
  switch (chip.field) {
    case "question":
      return t(`operations.questions.label.${chip.value}`, { defaultValue: chip.value });
    case "cashStatus":
      return each(chip.value, "driverCashStatuses");
    case "deliveryStatus":
    case "settlementStatus":
    case "orderType":
      return each(chip.value, "statuses");
    default:
      return chip.value;
  }
}

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
  persistenceScope,
}: {
  api: ApiClient;
  onNavigate: (path: string) => void;
  permissions: readonly string[];
  persistenceScope?: { readonly companyId: string; readonly userId: string };
}) {
  const { i18n, t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const traderReportPdf = useReconciliationPdfActions(api);
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
  /* Orders menu. `undefined` until the menu request settles, `null` when the
     Company is on the standard menu (switch off, never saved, or the request
     failed) -- in which case every tab, request and count below is exactly
     what it was before the menu existed. */
  const [orderMenu, setOrderMenu] = useState<readonly OrderView[] | null | undefined>(undefined);
  const [menuViewCounts, setMenuViewCounts] = useState<Readonly<Record<string, number>>>({});
  const menuDefaultApplied = useRef(false);
  const [accountantCollect] = useState<readonly OperationsPendingCashOrder[]>([]);
  const [accountantSection, setAccountantSection] = useState<"collect" | "pay">("collect");
  const [, setAccountantRefreshNonce] = useState(0);
  const [accountantPayOrders] = useState<Readonly<Record<string, readonly AccountantPayOrder[]>>>(
    {},
  );
  const [emirates, setEmirates] = useState<readonly Emirate[]>([]);
  const [filterEmirateId, setFilterEmirateId] = useState("");
  /* The search box types into local state and reaches the filter -- and so the
     request -- only on Enter. Searching per keystroke sent one request per
     character against a 100-per-minute limit and returned
     `ThrottlerException: Too Many Requests`; a debounce reduced that but still
     fired searches nobody asked for, on half-typed terms. Enter makes the
     search an explicit act. */
  // Seed the draft box from the URL-backed filter. Starting empty briefly
  // makes the "clearing the box applies at once" effect erase a restored
  // search before the input has a chance to sync from `filters.search`.
  const [searchText, setSearchText] = useState(filters.search);
  // Seeded from the URL-backed filter like the main search box, so returning
  // from an Order shows the serial filter that is still applied.
  const [referenceSearchText, setReferenceSearchText] = useState(filters.referenceNumber);
  const [filterArea, setFilterArea] = useState<CompanyArea>();
  const [drivers, setDrivers] = useState<readonly OperationsDriver[]>([]);
  const [traders, setTraders] = useState<readonly OperationsTrader[]>([]);
  const [areas, setAreas] = useState<readonly CompanyArea[]>([]);
  const [carrierFilterOptions, setCarrierFilterOptions] = useState<
    readonly { id: string; name: string }[]
  >([]);
  const [countryFilterOptions, setCountryFilterOptions] = useState<
    readonly { id: string; name: string }[]
  >([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<OrderGrouping>("");
  const [questionCounts, setQuestionCounts] = useState<Readonly<Record<string, OrderQuestionCount>>>(
    {},
  );
  const [closeAllStage, setCloseAllStage] = useState<"idle" | "confirm" | "busy">("idle");
  /* Question box (step 6): the typed question, and how it was understood. */
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askResult, setAskResult] = useState<OrderAskResult>();
  const [askError, setAskError] = useState<string>();
  /* The question the shown answer belongs to (what a favourite saves). */
  const [askedQuestion, setAskedQuestion] = useState("");
  const favouritesKey =
    persistenceScope === undefined ? null : favouriteQuestionsKey(persistenceScope);
  const [favourites, setFavourites] = useState<readonly string[]>(() =>
    readFavouriteQuestions(favouritesKey),
  );
  useEffect(() => {
    setFavourites(readFavouriteQuestions(favouritesKey));
  }, [favouritesKey]);
  const saveFavourites = (next: readonly string[]) => {
    setFavourites(next);
    if (favouritesKey === null) return;
    try {
      window.localStorage.setItem(favouritesKey, JSON.stringify(next));
    } catch {
      // Storage blocked by the browser: the list still works until a reload.
    }
  };
  /** A favourite's text: ready-made ones in the screen's language. */
  const favouriteText = (item: string) =>
    item.startsWith(defaultFavouritePrefix)
      ? t(`operations.questions.defaults.${item.slice(defaultFavouritePrefix.length)}`)
      : item;
  const isFavourite = (question: string) =>
    favourites.some((item) => sameQuestion(favouriteText(item), question));
  const removeFavourite = (item: string) =>
    saveFavourites(favourites.filter((current) => current !== item));
  const toggleFavourite = (question: string) => {
    const trimmed = question.trim();
    if (trimmed === "") return;
    saveFavourites(
      isFavourite(trimmed)
        ? favourites.filter((item) => !sameQuestion(favouriteText(item), trimmed))
        : [...favourites, trimmed].slice(-favouriteQuestionsLimit),
    );
  };
  const [favouritesOpen, setFavouritesOpen] = useState(false);
  const favouritesRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!favouritesOpen) return;
    const close = (event: MouseEvent) => {
      if (!favouritesRef.current?.contains(event.target as Node)) setFavouritesOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFavouritesOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [favouritesOpen]);
  /* Orders AI, switched on per Company by the Platform (read with the menu). */
  const [ordersAiEnabled, setOrdersAiEnabled] = useState(false);
  const persistenceKey =
    persistenceScope === undefined
      ? null
      : ordersListStateStorageKey(persistenceScope.companyId, persistenceScope.userId);
  const [restoredPersistenceKey, setRestoredPersistenceKey] = useState<string | null>(null);
  const previousPersistenceKey = useRef(persistenceKey);
  const listStateRestored = persistenceKey === null || restoredPersistenceKey === persistenceKey;
  const matchingCount = data?.matchingCount ?? data?.filteredCount ?? 0;
  const tabTotalCount = data?.tabTotalCount ?? data?.totalCount ?? 0;
  const hasNarrowingFilters = [
    filters.areaId,
    filters.emirateId,
    filters.dateFrom,
    filters.dateTo,
    filters.deliveryStatus,
    filters.cancellationReason,
    filters.driverId,
    filters.orderType,
    filters.thirdPartyDeliveryCompanyName,
    filters.deliveryDateFrom,
    filters.deliveryDateTo,
    filters.businessDateFrom,
    filters.businessDateTo,
    filters.referenceNumber,
    filters.search,
    filters.serialNumber,
    filters.traderId,
    filters.cashStatus,
    filters.settlementStatus,
    // A ready question narrows the list too: show "19 of 146", not the tab total.
    filters.question,
  ].some((value) => value !== "");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<SelectionSummary>();
  const [bulkAction, setBulkAction] = useState<BulkAction>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdNotice, setCreatedNotice] = useState<string>();
  const [fastEntryOpen, setFastEntryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [rowStatusColors, setRowStatusColors] = useState(() => {
    try {
      return window.localStorage.getItem("blueline.orders.rowStatusColors") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "blueline.orders.rowStatusColors",
        rowStatusColors ? "on" : "off",
      );
    } catch {
      // Storage may be unavailable in private browsing; the UI still works.
    }
  }, [rowStatusColors]);

  const query = useMemo(() => {
    const parameters = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    // Orders keeps sort state in the shared list URL convention (`sort` and
    // `direction`), while the API contract names these `sortBy` and
    // `sortDirection`.
    if (list.sortBy !== "orderDate") parameters.set("sortBy", list.sortBy);
    if (list.sortDirection !== "desc") parameters.set("sortDirection", list.sortDirection);
    // Delivery Activity is carried by `deliveredOnly`, never by `quickView`.
    // Sending an unknown quick view would fall through to the Active predicate
    // and quietly return the wrong Orders.
    if (backendQuickViews.has(filters.quickView)) {
      parameters.set("quickView", filters.quickView);
    } else if (filters.quickView === "ai") {
      // The AI tab is frontend-only: it lists all Orders (Aiman, 11 Oct 2026).
      parameters.set("quickView", "all");
    }
    for (const [key, value] of Object.entries(filters)) {
      if (key !== "quickView" && value !== "") parameters.set(key, value);
    }
    return parameters.toString();
  }, [filters, list.sortBy, list.sortDirection, page, pageSize]);

  useEffect(() => {
    if (persistenceKey === null) return;
    if (previousPersistenceKey.current !== persistenceKey) {
      previousPersistenceKey.current = persistenceKey;
      setRestoredPersistenceKey(null);
      const cleanSearch = removeOrdersListSearch(location.search);
      if (cleanSearch !== location.search) {
        navigate(
          { pathname: location.pathname, search: cleanSearch, hash: location.hash },
          { replace: true },
        );
      }
      return;
    }
    if (restoredPersistenceKey === persistenceKey) return;

    let snapshot;
    try {
      snapshot = readOrdersListSnapshot(window.localStorage, persistenceKey);
    } catch {
      snapshot = undefined;
    }
    const currentParameters = new URLSearchParams(location.search);
    if (hasOrdersListState(currentParameters)) {
      setGrouping(snapshot?.grouping.length ? [...snapshot.grouping] : "");
      if (snapshot?.search !== undefined && snapshot.search !== "") {
        const restoredSearch = restoreOrdersListSearch(location.search, snapshot.search);
        if (restoredSearch !== location.search) {
          navigate(
            { pathname: location.pathname, search: restoredSearch, hash: location.hash },
            { replace: true },
          );
          return;
        }
      }
      setRestoredPersistenceKey(persistenceKey);
      return;
    }
    if (snapshot?.search !== undefined && snapshot.search !== "") {
      const restoredSearch = restoreOrdersListSearch(location.search, snapshot.search);
      if (restoredSearch !== location.search) {
        setGrouping(snapshot.grouping.length ? [...snapshot.grouping] : "");
        navigate(
          { pathname: location.pathname, search: restoredSearch, hash: location.hash },
          { replace: true },
        );
        return;
      }
    }
    setGrouping(snapshot?.grouping.length ? [...snapshot.grouping] : "");
    setRestoredPersistenceKey(persistenceKey);
  }, [
    location.hash,
    location.pathname,
    location.search,
    navigate,
    persistenceKey,
    restoredPersistenceKey,
  ]);

  useEffect(() => {
    if (persistenceKey === null || !listStateRestored) return;
    try {
      writeOrdersListSnapshot(window.localStorage, persistenceKey, location.search, grouping || []);
    } catch {
      // Orders remains usable when storage is blocked by browser settings.
    }
  }, [grouping, listStateRestored, location.search, persistenceKey]);

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

  /* With a custom menu, the tab in the URL is checked against the menu once it
     arrives. The first list request is NOT held back for it: Companies on the
     standard menu load exactly when they always did. A custom-menu Company may
     see one extra request on first open while its default tab is applied. */
  const menuNormalization = useMemo((): Record<string, string> | null => {
    // The AI tab in a URL after the Platform switched Orders AI off.
    if (orderMenu !== undefined && filters.quickView === "ai" && !ordersAiEnabled) {
      return { quickView: "active", viewKey: "" };
    }
    if (orderMenu === undefined || orderMenu === null) {
      // Back on the standard menu: a tab left over from the custom menu has
      // no meaning any more.
      return orderMenu === null && filters.viewKey !== ""
        ? { quickView: "active", viewKey: "" }
        : null;
    }
    const visible = orderMenu.filter(
      (view) => view.isVisible && (view.key !== "ai" || ordersAiEnabled),
    );
    const fallback = visible.find((view) => view.isDefault) ?? visible[0];
    const target = (view: OrderView | undefined): Record<string, string> =>
      view === undefined ? { quickView: "active", viewKey: "" } : menuViewFilters(view);
    if (filters.viewKey !== "") {
      // A tab that was deleted or hidden since the URL was written.
      const known = visible.find((view) => view.key === filters.viewKey);
      return known === undefined ? target(fallback) : null;
    }
    if (!menuDefaultApplied.current && list.filters.quickView === undefined) {
      return target(fallback);
    }
    // Active Orders under a custom menu always follows the menu's statuses.
    if (filters.quickView === "active") return { viewKey: "active" };
    return null;
  }, [filters.quickView, filters.viewKey, list.filters.quickView, orderMenu, ordersAiEnabled]);

  useEffect(() => {
    if (orderMenu === undefined) return;
    if (orderMenu !== null) menuDefaultApplied.current = true;
    if (menuNormalization !== null) {
      list.setFilters({
        ...menuNormalization,
        businessDateFrom: "",
        businessDateTo: "",
        dateMode: "",
        deliveredOnly: "",
        deliveryDateFrom: "",
        deliveryDateTo: "",
      });
    }
    // Runs when the decision changes; `list` is deliberately not a dependency.
  }, [menuNormalization, orderMenu]);

  useEffect(() => {
    if (listStateRestored && menuNormalization === null) void load();
  }, [listStateRestored, load, menuNormalization]);

  useEffect(() => {
    let active = true;
    void api
      .get<OrderViewsMenu>("configuration/order-views")
      .then((menu) => {
        if (!active) return;
        setOrdersAiEnabled(
          menu !== null && typeof menu === "object" && menu.aiEnabled === true,
        );
        setOrderMenu(
          menu !== null &&
            typeof menu === "object" &&
            menu.enabled === true &&
            Array.isArray(menu.views)
            ? menu.views
            : null,
        );
      })
      .catch(() => {
        // The standard menu is always a safe answer.
        if (active) setOrderMenu(null);
      });
    return () => {
      active = false;
    };
  }, [api]);

  // Reference data that no filter changes: fetched once per mount rather than
  // with every list reload.
  useEffect(() => {
    let active = true;
    void (async () => {
      const [holdOrders, loadedDrivers, loadedTraders, loadedCarriers, loadedCountries] =
        await Promise.allSettled([
          api.get<OperationsOrderPage>("operations/orders?page=1&pageSize=25&quickView=hold"),
          api.get<readonly OperationsDriver[]>("operations/drivers"),
          api.get<readonly OperationsTrader[]>("operations/traders"),
          api.get<SearchPage<{ id: string; name: string }>>(
            "operations/third-party-delivery-companies",
          ),
          api.get<SearchPage<{ id: string; name: string }>>("operations/destination-countries"),
        ]);
      if (!active) return;
      if (holdOrders.status === "fulfilled") {
        setHoldCount(holdOrders.value.tabTotalCount ?? holdOrders.value.filteredCount);
      }
      if (loadedDrivers.status === "fulfilled") {
        setDrivers(loadedDrivers.value.filter((driver) => driver.status === "active"));
      }
      // Active only, exactly as before the split.
      if (loadedTraders.status === "fulfilled") {
        setTraders(loadedTraders.value.filter((trader) => trader.status === "active"));
      }
      if (loadedCarriers.status === "fulfilled") {
        setCarrierFilterOptions(
          Array.isArray(loadedCarriers.value)
            ? loadedCarriers.value
            : (loadedCarriers.value.items ?? []),
        );
      }
      if (loadedCountries.status === "fulfilled") {
        setCountryFilterOptions(
          Array.isArray(loadedCountries.value)
            ? loadedCountries.value
            : (loadedCountries.value.items ?? []),
        );
      }

      // Load areas for each emirate to build area-emirate mapping
      if (active && emirates.length > 0) {
        console.log("Loading areas for emirates:", emirates.length);
        try {
          const allAreas: CompanyArea[] = [];
          for (const emirate of emirates) {
            try {
              const response = await api.get<{
                items: readonly CompanyArea[];
                total: number;
                hasMore: boolean;
              }>(
                `configuration/areas/search?emirateId=${encodeURIComponent(emirate.id)}&activeOnly=true`,
              );
              console.log(`Areas for ${emirate.nameEn}:`, response);
              // API returns paginated response with items array
              if (response?.items && Array.isArray(response.items)) {
                allAreas.push(...response.items);
              }
            } catch (error) {
              console.error(`Failed to load areas for ${emirate.nameEn}:`, error);
            }
          }
          console.log("Total areas loaded:", allAreas.length);
          if (active && allAreas.length > 0) {
            setAreas(allAreas);
          }
        } catch (error) {
          console.error("Areas loading failed:", error);
        }
      } else {
        console.log("Skipping areas load - emirates not ready", {
          emiratesLength: emirates.length,
          active,
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [api, emirates]);

  // Emirates scope the Area filter; load them once.
  useEffect(() => {
    let active = true;
    void api
      .get<readonly Emirate[]>("configuration/emirates")
      .then((loaded) => {
        console.log("Emirates loaded:", loaded);
        active && setEmirates(Array.isArray(loaded) ? loaded : []);
      })
      .catch((error) => {
        console.error("Failed to load emirates:", error);
      });
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
    () => selectionPayload(filters, allMatching, excludedIds, selectedIds),
    [allMatching, excludedIds, filters, selectedIds],
  );
  // Explicit rows only -- "select all matching" can span far more Orders than
  // is sane to carry in a URL, so that mode hands over just the Driver filter
  // (when set) and lets the destination screen's own eligible-Orders list do
  // the rest.
  const bulkSelectedOrders = useMemo(
    () => (allMatching ? [] : (data?.items ?? []).filter((order) => selectedIds.has(order.id))),
    [allMatching, data, selectedIds],
  );
  const manifestSelection = useMemo<ManifestSelectionPayload>(
    () => cleanSelectionPayload(filters, allMatching, excludedIds, selectedIds),
    [allMatching, excludedIds, filters, selectedIds],
  );
  const selectedCount = allMatching
    ? Math.max(0, matchingCount - excludedIds.size)
    : selectedIds.size;
  const selectedHasInternational = bulkSelectedOrders.some(
    (order) => order.orderType === "gcc_international",
  );

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

  /* Ready-question counts, refreshed with every list load so a count never
     lags behind an action the operator just took (closing, collecting...). */
  useEffect(() => {
    // The ready questions live on the AI tab only (Aiman, 11 Oct 2026).
    if (filters.quickView !== "ai") return;
    let active = true;
    void api
      .get<{ items: readonly OrderQuestionCount[] }>("operations/orders/questions")
      .then((result) => {
        if (!active) return;
        setQuestionCounts(Object.fromEntries((result.items ?? []).map((item) => [item.key, item])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, data, filters.quickView]);

  /* One click answers the question: the list shows exactly its Orders, grouped
     the way the next action works (per Driver to collect, per Trader to pay).
     Clicking the active question again returns to the normal list. */
  /* "Close all ready" (step 4). The existing bulk Close, scoped by the
     question: the API re-checks every Order against the real close gate under
     row locks and skips -- never forces -- one that stopped being ready since
     the count was read. */
  const closeAllReady = async () => {
    setCloseAllStage("busy");
    try {
      const result = await api.post<{
        ineligible: readonly { orderNumber: string; reason: string }[];
        processedCount: number;
      }>("operations/orders/bulk-status", {
        allowPartial: true,
        excludedOrderIds: [],
        question: "ready_to_close",
        selectionMode: "filter",
        targetStatus: "closed",
      });
      const skipped = result.ineligible ?? [];
      setOrderActionNotice(
        [
          t("operations.questions.closeAllDone", { count: result.processedCount }),
          skipped.length === 0
            ? ""
            : `${t("operations.questions.closeAllSkipped", { count: skipped.length })} ${skipped
                .map((item) => item.orderNumber)
                .join(", ")}`,
        ]
          .filter((line) => line !== "")
          .join(" "),
      );
      clearSelection();
      await load();
    } catch (requestError) {
      setOrderActionNotice(bulkStatusError(requestError, t));
    } finally {
      setCloseAllStage("idle");
    }
  };

  const clearAsk = () => {
    setAskResult(undefined);
    setAskError(undefined);
  };

  /* The question box. The API turns the question into allow-listed Orders
     filters (the AI never sees an Order); the answer is the normal list with
     exactly those filters -- every other filter is cleared so nothing left
     over from before changes the answer. */
  const askOrders = async (asked?: string) => {
    const question = (asked ?? askText).trim();
    if (question.length < 2 || askBusy) return;
    setAskBusy(true);
    setAskError(undefined);
    try {
      const result = await api.post<OrderAskResult>("operations/orders/ask", {
        language: locale,
        question,
      });
      setCloseAllStage("idle");
      setAskResult(result);
      setAskedQuestion(question);
      if (result.unsupported) return;
      const applied = Object.fromEntries(
        Object.entries(result.filters ?? {}).filter(([key]) => orderFilterKeys.includes(key)),
      );
      list.setFilters({
        ...Object.fromEntries(orderFilterKeys.map((key) => [key, ""])),
        ...applied,
        // The answer stays on the AI tab (it lists all Orders).
        quickView: "ai",
      });
      const ready = orderQuestions.find((item) => item.key === applied.question);
      setGrouping(ready === undefined || ready.grouping === null ? "" : [ready.grouping]);
      clearSelection();
    } catch (requestError) {
      setAskResult(undefined);
      setAskError(
        requestError instanceof ApiError && requestError.code === "order_question_ai_unavailable"
          ? t("operations.questions.aiUnavailable")
          : t("operations.questions.askFailed"),
      );
    } finally {
      setAskBusy(false);
    }
  };

  /* Removing a chip clears exactly the filters it set. */
  const removeAskChip = (chip: OrderAskChip) => {
    const change: Record<string, string> = Object.fromEntries(
      chip.filterKeys.map((key) => [key, ""]),
    );
    // Delivered dates live in the Delivery Activity view; without them the
    // answer goes back to all Orders.
    if (chip.field === "deliveredDate") change.quickView = "ai";
    if (chip.field === "question") setGrouping("");
    setFilters((current) => ({ ...current, ...change }));
  };

  const selectQuestion = (question: (typeof orderQuestions)[number]) => {
    setCloseAllStage("idle");
    clearAsk();
    if (filters.question === question.key) {
      updateFilters({ question: "" });
      setGrouping("");
    } else {
      updateFilters({ question: question.key });
      setGrouping(question.grouping === null ? "" : [question.grouping]);
    }
  };

  // Filter -> box: Clear filters, or arriving on a URL that already carries a
  // term. Guarded on inequality so it cannot fight the user's typing.
  useEffect(() => {
    setSearchText((current) => (current === filters.search ? current : filters.search));
  }, [filters.search]);
  useEffect(() => {
    setReferenceSearchText((current) =>
      current === filters.referenceNumber ? current : filters.referenceNumber,
    );
  }, [filters.referenceNumber]);

  /* Clearing the box applies at once. Waiting for Enter to reveal the full list
     again would leave the operator looking at filtered results with an empty
     search box, which reads as a bug. Only a non-empty term waits for Enter. */
  useEffect(() => {
    if (searchText === "" && filters.search !== "") updateFilters({ search: "" });
    // `updateFilters` is recreated every render and is not a real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, filters.search]);

  // Close grouping popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const anchor = document.getElementById("grouping-popover-anchor");
      const popover = document.getElementById("grouping-popover");
      if (anchor && popover && !anchor.contains(event.target as Node)) {
        popover.style.display = "none";
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

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

  const selectQuickView = (view: QuickView) => {
    clearAsk();
    list.setFilters({
      question: "",
      quickView: view,
      viewKey: "",
      cancellationReason: "",
      businessDateFrom: "",
      businessDateTo: "",
      deliveryDateFrom: "",
      deliveryDateTo: "",
      ...(view === "delivery"
        ? { dateMode: "", deliveredOnly: "" }
        : { dateMode: "", deliveredOnly: "" }),
    });
  };
  // Orders menu tabs, in the Company's order; null on the standard menu.
  const menuTabs = useMemo(
    () =>
      orderMenu === undefined || orderMenu === null
        ? null
        : orderMenu.filter(
            // The AI tab needs Orders AI switched on by the Platform.
            (view) => view.isVisible && (view.key !== "ai" || ordersAiEnabled),
          ),
    [orderMenu, ordersAiEnabled],
  );
  const selectedMenuKey = filters.viewKey !== "" ? filters.viewKey : filters.quickView;
  const selectedMenuView = menuTabs?.find((view) => view.key === selectedMenuKey);
  const selectMenuView = (view: OrderView) => {
    clearAsk();
    list.setFilters({
      ...menuViewFilters(view),
      question: "",
      cancellationReason: "",
      businessDateFrom: "",
      businessDateTo: "",
      dateMode: "",
      deliveredOnly: "",
      deliveryDateFrom: "",
      deliveryDateTo: "",
    });
  };
  const countScope =
    selectedMenuView !== undefined && selectedMenuView.kind === "custom"
      ? orderViewLabel(selectedMenuView, i18n.resolvedLanguage ?? "en")
      : t(`operations.countScope.${filters.quickView}`);
  /* Counts for the menu tabs that show one. One small request per tab, the
     same way the Hold count has always been read; refreshed when the user
     changes tab so a count never lags far behind. The selected tab shows the
     live total of the list itself. Hold keeps its existing request. */
  useEffect(() => {
    if (menuTabs === null) return;
    let active = true;
    const counted = menuTabs.filter((view) => view.showCount && view.key !== "hold");
    void Promise.allSettled(
      counted.map((view) =>
        api.get<OperationsOrderPage>(`operations/orders?${menuViewCountQuery(view)}`),
      ),
    ).then((results) => {
      if (!active) return;
      const next: Record<string, number> = {};
      results.forEach((result, index) => {
        if (
          result.status === "fulfilled" &&
          result.value !== null &&
          typeof result.value === "object"
        ) {
          const count = result.value.tabTotalCount ?? result.value.filteredCount;
          if (typeof count === "number") next[counted[index]!.key] = count;
        }
      });
      setMenuViewCounts(next);
    });
    return () => {
      active = false;
    };
  }, [api, menuTabs, selectedMenuKey]);
  const loadedOrderItems = Array.isArray(data?.items) ? data.items : [];
  const deliveryActivityExcludedActions = new Set([
    "collect_from_driver",
    "collect_trader_receivable",
    "pay_trader",
    "close_order",
    "none",
  ]);
  const orderItems = deliveryView
    ? loadedOrderItems.filter(
        (order) =>
          order.deliveryStatus !== "closed" &&
          order.deliveryStatus !== "cancelled" &&
          order.workflowGuidance?.workflowState !== "complete" &&
          !deliveryActivityExcludedActions.has(order.workflowGuidance?.nextActionCode ?? "none"),
      )
    : loadedOrderItems;
  const traderFilterOptions = Array.isArray(traders) ? traders : [];
  const driverFilterOptions = Array.isArray(drivers) ? drivers : [];
  const emirateFilterOptions = Array.isArray(emirates) ? emirates : [];
  const pageIds = orderItems.map((order) => order.id);
  const isAdministrator = permissions.includes("users_roles.manage");
  const canAssignDriver = isAdministrator || permissions.includes("orders.assign_driver");
  const canUpdateStatus = isAdministrator || permissions.includes("orders.update_delivery_status");
  const canReconcile = isAdministrator || permissions.includes("reconciliations.create");
  const canSettle = isAdministrator || permissions.includes("settlements.create");
  const canAsk = permissions.some((permission) => orderAskPermissions.includes(permission));
  /* The question box and favourites live on the AI tab only. */
  const aiTab = filters.quickView === "ai" && ordersAiEnabled && canAsk;
  const selectedReportOrder = bulkSelectedOrders.length === 1 ? bulkSelectedOrders[0] : undefined;
  const traderReceivableOrders = bulkSelectedOrders.filter(
    (order) => Number(order.traderReceivableOutstanding ?? 0) > 0 && order.traderId,
  );
  const traderReceivableTraderId = traderReceivableOrders[0]?.traderId;
  const selectedTraderReceivableId =
    traderReceivableOrders.length === 1 ? traderReceivableOrders[0]?.traderReceivableId : undefined;
  const canCollectSelectedTraderReceivables =
    traderReceivableOrders.length > 0 &&
    traderReceivableOrders.every((order) => order.traderId === traderReceivableTraderId);
  const canOpenTraderCollectionReport =
    selectedReportOrder !== undefined &&
    Number(selectedReportOrder.traderReceivableOutstanding ?? 0) <= 0 &&
    selectedReportOrder.traderReceivableId !== null &&
    selectedReportOrder.traderReceivableId !== undefined;
  const canOpenTraderSettlementReport =
    selectedReportOrder !== undefined &&
    Number(selectedReportOrder.traderNetPayable ?? 0) > 0 &&
    !["not_eligible", "unsettled"].includes(selectedReportOrder.traderSettlementStatus);
  const openTraderReport = async (kind: "collection" | "settlement") => {
    if (selectedReportOrder === undefined) return;
    if (kind === "collection" && canOpenTraderCollectionReport) {
      const link = await api.get<{ collectionId: string; collectionNumber: string } | undefined>(
        `operations/trader-receivables/collections-for-order/${selectedReportOrder.id}`,
      );
      if (link !== undefined) {
        await traderReportPdf.run(
          `operations/trader-receivables/collections/${link.collectionId}/pdf?language=${locale}`,
          `Trader-Collection-${link.collectionNumber}.pdf`,
          "preview",
        );
        return;
      }
      /* No Collection exists for this Order. That does NOT mean the Trader
         never paid: a Receivable cleared by netting inside a Trader Settlement
         writes a settlement offset and no `trader_collections` row at all, and
         `collections-for-order` joins through `trader_collection_allocations`,
         so it finds nothing. This button was enabled (a Receivable exists and
         is fully collected) and then did nothing whatsoever when clicked.
         Open the Receivable itself instead -- from there the Cleared By column
         and the detail dialog name the Settlement that cleared it. */
      if (
        selectedReportOrder.traderReceivableId !== null &&
        selectedReportOrder.traderReceivableId !== undefined
      ) {
        onNavigate(`/trader-receivables/${selectedReportOrder.traderReceivableId}`);
      }
      return;
    }
    if (kind === "settlement" && canOpenTraderSettlementReport) {
      const link = await api.get<{ settlementId: string; settlementNumber: string } | undefined>(
        `operations/orders/${selectedReportOrder.id}/trader-settlement`,
      );
      if (link !== undefined) {
        await traderReportPdf.run(
          `operations/settlements/payments/${link.settlementId}/pdf?language=${locale}`,
          `Trader-Settlement-${link.settlementNumber}.pdf`,
          "preview",
        );
      }
    }
  };
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
  const copyNumbers = async () => {
    const valid: string[] = [];
    let invalid = 0;
    for (const order of bulkSelectedOrders) {
      const mobile = normalizeUaeMobile(order.customerMobileNumber);
      if (mobile === undefined) {
        invalid += 1;
        continue;
      }
      valid.push(`+${mobile} - ${order.areaName}`);
    }
    if (valid.length > 0) await navigator.clipboard.writeText(valid.join("\n"));
    setOrderActionNotice(
      invalid === 0
        ? t("operations.copyNumbersSuccess", { count: valid.length })
        : t("operations.copyNumbersPartial", { copied: valid.length, invalid }),
    );
  };
  const orderSelected = (id: string) => (allMatching ? !excludedIds.has(id) : selectedIds.has(id));
  // Build area-to-emirate mapping from areas configuration
  // Since emirateNameEn is not in the orders list, we must use the areas data
  const areaEmirateMap = useMemo(() => {
    const map = new Map<string, { code: string; name: string }>();

    // Build emirate code to name lookup
    const emirateCodeToName = new Map<string, string>();
    for (const emirate of emirates) {
      const mapping = {
        code: emirate.code.toUpperCase(),
        name: localizeName(locale, { ar: emirate.nameAr, en: emirate.nameEn }),
      };
      emirateCodeToName.set(emirate.code.toUpperCase(), mapping.name);
      map.set(emirate.id, mapping);
    }

    // Map all areas to their emirates
    // Each order has an areaName, and we need to find the emirate for that area
    for (const area of areas) {
      if (!area.emirateCode) continue;

      const emirateCode = area.emirateCode.toUpperCase();
      const emirateName = emirateCodeToName.get(emirateCode);

      if (!emirateName) continue; // Skip if we can't find the emirate name

      const mapping = { code: emirateCode, name: emirateName };

      // Map both English and Arabic area names to the emirate
      if (area.nameEn) {
        map.set(area.nameEn, mapping);
      }
      if (area.nameAr) {
        map.set(area.nameAr, mapping);
      }
      map.set(area.id, mapping);
    }

    console.log("areaEmirateMap built:", {
      mapSize: map.size,
      areasCount: areas.length,
      emiratesCount: emirates.length,
      mapEntries: Array.from(map.entries()).slice(0, 5),
    });

    return map;
  }, [areas, emirates, locale]);

  const groups = useMemo(
    () => groupVisibleOrders(orderItems, grouping, t, locale, areaEmirateMap),
    [orderItems, grouping, t, locale, areaEmirateMap],
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

  const toggleGroupingDimension = (
    dimension: "area" | "emirate" | "trader" | "driver" | "status",
  ) => {
    const current = Array.isArray(grouping) ? grouping : [];
    const updated = current.includes(dimension)
      ? current.filter((d) => d !== dimension)
      : [...current, dimension];
    changeGrouping(updated.length === 0 ? "" : (updated as OrderGrouping));
  };

  const clearAllGrouping = () => {
    changeGrouping("");
  };

  /* Ready questions (step 3): the next action for one Driver or one Trader,
     straight from its group header. Each opens the EXISTING screen and dialog
     with that Driver or Trader preselected; nothing is written from here, and
     every check of the target screen still applies. */
  const questionGroupAction = (
    group: VisibleOrderGroup,
  ): { readonly label: string; readonly path: string } | null => {
    const first = group.orders[0];
    if (filters.question === "" || first === undefined) return null;
    const orderIds = group.orders.map((order) => order.id);
    /* Come back to THIS view -- the question and its filters -- not to a bare
       /orders. The saved list state deliberately does not restore a question,
       so returning to /orders dropped it: the group button vanished and the
       "1 of 2" receipt flow could not move on to the next settlement
       (13 Oct 2026). */
    const returnPath = `/orders${location.search}`;
    const back = encodeURIComponent(returnPath);
    if (filters.question === "collect_from_driver" && group.key.startsWith("driver:")) {
      if (!canReconcile || !first.assignedDriverId) return null;
      return {
        label: t("operations.questions.groupAction.collect"),
        path: collectFromDriverPath({
          driverId: first.assignedDriverId,
          orderIds,
          returnTo: returnPath,
        }),
      };
    }
    if (!group.key.startsWith("trader:") || !first.traderId) return null;
    const traderId = encodeURIComponent(first.traderId);
    if (filters.question === "pay_trader" && canSettle) {
      return {
        label: t("operations.questions.groupAction.settle"),
        path: `/trader-settlements?openDialog=new_settlement&traderId=${traderId}&returnTo=${back}`,
      };
    }
    if (filters.question === "confirm_trader_receipt" && canSettle) {
      /* Receipt is confirmed per settlement, so the button names one: the
         settlement the first Order of this Trader points to (the oldest one
         waiting). Without it the settlements screen cannot know which dialog
         to open. Several settlements: confirm one, come back, and the button
         moves on to the next. */
      const settlementIds = [
        ...new Set(
          group.orders
            .map((order) => order.workflowGuidance?.nextActionParams.settlementId)
            .filter((id): id is string => typeof id === "string" && id !== ""),
        ),
      ];
      const settlementId = settlementIds[0];
      return {
        label:
          settlementIds.length > 1
            ? t("operations.questions.groupAction.confirmReceiptMany", { count: settlementIds.length })
            : t("operations.questions.groupAction.confirmReceipt"),
        path:
          settlementId === undefined
            ? `/trader-settlements?openDialog=confirm_receipt&traderId=${traderId}&returnTo=${back}`
            : `/trader-settlements?openDialog=confirm_receipt&traderId=${traderId}&settlementId=${encodeURIComponent(settlementId)}&returnTo=${back}`,
      };
    }
    if (filters.question === "trader_owes_fees") {
      return {
        label: t("operations.questions.groupAction.collectFees"),
        path: `/trader-receivables?collectTraderId=${traderId}&returnTo=${back}`,
      };
    }
    return null;
  };

  const renderGroupsRecursive = (groups: readonly VisibleOrderGroup[]): React.ReactNode => {
    return groups.flatMap((group) => {
      const hasChildren = group.children.length > 0;
      const leafOrders = hasChildren ? [] : group.orders;
      const allOrderIds = hasChildren
        ? getAllOrderIdsFromGroup(group)
        : group.orders.map((o) => o.id);
      const selectedInGroup = allOrderIds.filter(orderSelected).length;
      const expanded = !collapsedGroups.has(group.key);
      const paddingLeft = group.level * 20;

      return [
        <Fragment key={group.key}>
          <tr
            className={`order-group-row order-group-level-${group.level}`}
            style={{ paddingLeft }}
          >
            <td style={{ paddingLeft: `${paddingLeft}px` }}>
              {canSelectOrders ? (
                <GroupSelectionCheckbox
                  checked={selectedInGroup === allOrderIds.length && allOrderIds.length > 0}
                  indeterminate={selectedInGroup > 0 && selectedInGroup < allOrderIds.length}
                  label={t("operations.selectVisibleGroup", {
                    group: group.label,
                  })}
                  onChange={() => toggleGroup(allOrderIds)}
                />
              ) : null}
            </td>
            <td colSpan={14}>
              {hasChildren ? (
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
                  <span>{t("operations.visibleOrderCount", { count: allOrderIds.length })}</span>
                  {selectedInGroup > 0 ? (
                    <span>
                      {t("operations.groupSelectedCount", {
                        count: selectedInGroup,
                      })}
                    </span>
                  ) : null}
                </button>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <strong>{group.label}</strong>
                  <span>{t("operations.visibleOrderCount", { count: leafOrders.length })}</span>
                  {(() => {
                    const action = questionGroupAction(group);
                    return action === null ? null : (
                      <button
                        className="button button-primary order-group-action"
                        onClick={() => onNavigate(action.path)}
                        type="button"
                      >
                        {action.label}
                      </button>
                    );
                  })()}
                </div>
              )}
            </td>
          </tr>
        </Fragment>,
        expanded && hasChildren ? renderGroupsRecursive(group.children) : null,
        expanded && !hasChildren ? leafOrders.map(renderOrderRow) : null,
      ];
    });
  };

  const getAllOrderIdsFromGroup = (group: VisibleOrderGroup): readonly string[] => {
    if (group.orders.length > 0) return group.orders.map((o) => o.id);
    return group.children.flatMap(getAllOrderIdsFromGroup);
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
    const rowStatusClass = rowStatusColors
      ? order.orderType === "gcc_international"
        ? "order-row-status-international"
        : order.deliveryStatus === "cancelled"
          ? "order-row-status-cancelled"
          : order.deliveryStatus === "closed"
            ? "order-row-status-closed"
            : order.deliveryStatus === "delivered"
              ? "order-row-status-delivered"
              : order.deliveryStatus === "hold"
                ? "order-row-status-hold"
                : order.workflowGuidance?.nextActionCode === "collect_from_trader"
                  ? "order-row-status-collect"
                  : order.workflowGuidance?.nextActionCode === "settle_trader"
                    ? "order-row-status-pay"
                    : "order-row-status-new"
      : order.orderType === "gcc_international"
        ? "international-order-row"
        : undefined;
    return (
      <tr className={rowStatusClass} key={order.id}>
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
            {order.orderNumber}
          </button>
          {order.serialNumber === null ? null : (
            <span className="cell-secondary">
              {t("operations.serialNumber")}: {order.serialNumber}
            </span>
          )}
          <span className="cell-secondary">{formatDate(order.orderDate, locale)}</span>
        </td>
        <td className="mono">{order.psystemSerial ?? "—"}</td>
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
          {inCarrierStages(order) && order.internationalCarrierStatus ? (
            <span className="cell-secondary carrier-stage-label">
              {t(`operations.internationalCarrierStatuses.${order.internationalCarrierStatus}`)}
            </span>
          ) : null}
        </td>
        <td>
          <OrderAccountingBadge order={order} />
        </td>
        <td>
          <FinancialStatusCell onNavigate={onNavigate} order={order} permissions={permissions} />
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
      {createdNotice === undefined ? null : (
        <div className="alert alert-success order-created-notice" role="status">
          <span>{createdNotice}</span>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={() => setCreatedNotice(undefined)}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}
      <section className="orders-workspace">
        <div className="orders-quick-views" role="tablist" aria-label={t("operations.orderViews")}>
          {menuTabs !== null
            ? menuTabs.map((view) => {
                const selected = selectedMenuKey === view.key;
                const count = selected
                  ? tabTotalCount
                  : view.key === "hold"
                    ? holdCount
                    : menuViewCounts[view.key];
                return (
                  <button
                    aria-selected={selected}
                    className={selected ? "active" : undefined}
                    key={view.key}
                    onClick={() => selectMenuView(view)}
                    role="tab"
                    type="button"
                  >
                    {orderViewLabel(view, i18n.resolvedLanguage ?? "en")}
                    {view.showCount && count !== undefined ? (
                      <span className="tab-count">{count}</span>
                    ) : null}
                  </button>
                );
              })
            : (
                [
                  "active",
                  "hold",
                  "all",
                  "closed",
                  "cancelled",
                  "delivery",
                  "accountant",
                  ...(ordersAiEnabled ? (["ai"] as const) : []),
                ] as const
              ).map((view) => (
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
                  {view === "accountant" && filters.quickView === "accountant" ? (
                    <span className="tab-count">{tabTotalCount}</span>
                  ) : null}
                </button>
              ))}
        </div>
        {aiTab ? (
        <div
          aria-label={t("operations.questions.title")}
          className="order-questions"
          role="group"
        >
          <span className="order-questions-title">{t("operations.questions.title")}</span>
          {/* Only questions with work waiting are shown (a 0 is noise). The
              open question stays, even at 0, so the operator sees it is done
              and can click it to return to the list. */}
          {Object.keys(questionCounts).length > 0 &&
          !orderQuestions.some(
            (question) =>
              (questionCounts[question.key]?.count ?? 0) > 0 || filters.question === question.key,
          ) ? (
            <span className="order-questions-clear">{t("operations.questions.allClear")}</span>
          ) : null}
          {orderQuestions.map((question) => {
            const counted = questionCounts[question.key];
            const selected = filters.question === question.key;
            if (!selected && (counted === undefined || counted.count === 0)) return null;
            const classes = ["order-question"];
            if (selected) classes.push("active");
            return (
              <button
                aria-pressed={selected}
                className={classes.join(" ")}
                key={question.key}
                onClick={() => selectQuestion(question)}
                title={t(`operations.questions.ask.${question.key}`)}
                type="button"
              >
                {t(`operations.questions.label.${question.key}`)}
                {counted === undefined ? null : (
                  <span className="tab-count">{counted.count}</span>
                )}
                {counted?.amount === null || counted?.amount === undefined || counted.count === 0 ? null : (
                  <span className="order-question-amount">
                    {formatCurrency(counted.amount, "AED", locale)}
                  </span>
                )}
              </button>
            );
          })}
          {filters.question === "ready_to_close" &&
          canUpdateStatus &&
          (questionCounts.ready_to_close?.count ?? 0) > 0 ? (
            <span className="order-questions-close-all">
              {closeAllStage === "idle" ? (
                <button
                  className="button button-primary"
                  onClick={() => setCloseAllStage("confirm")}
                  type="button"
                >
                  {t("operations.questions.closeAll", {
                    count: questionCounts.ready_to_close?.count ?? 0,
                  })}
                </button>
              ) : (
                <>
                  <span role="status">
                    {t("operations.questions.closeAllConfirm", {
                      count: questionCounts.ready_to_close?.count ?? 0,
                    })}
                  </span>
                  <button
                    className="button button-primary"
                    disabled={closeAllStage === "busy"}
                    onClick={() => void closeAllReady()}
                    type="button"
                  >
                    {closeAllStage === "busy"
                      ? t("common.working")
                      : t("operations.questions.closeAllYes")}
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={closeAllStage === "busy"}
                    onClick={() => setCloseAllStage("idle")}
                    type="button"
                  >
                    {t("common.cancel")}
                  </button>
                </>
              )}
            </span>
          ) : null}
          {aiTab ? (
            <form
              className="order-questions-ask"
              onSubmit={(event) => {
                event.preventDefault();
                void askOrders();
              }}
              role="search"
            >
              <input
                aria-label={t("operations.questions.askLabel")}
                maxLength={300}
                onChange={(event) => setAskText(event.target.value)}
                placeholder={t("operations.questions.askPlaceholder")}
                type="search"
                value={askText}
              />
              <span className="order-favourites" ref={favouritesRef}>
                <button
                  aria-expanded={favouritesOpen}
                  aria-label={t("operations.questions.favourites")}
                  className="button button-secondary order-favourites-toggle"
                  onClick={() => setFavouritesOpen((open) => !open)}
                  title={t("operations.questions.favourites")}
                  type="button"
                >
                  <span aria-hidden="true">★</span>
                  <span className="tab-count">{favourites.length}</span>
                </button>
                {favouritesOpen ? (
                  <div
                    aria-label={t("operations.questions.favourites")}
                    className="order-favourites-menu"
                    role="group"
                  >
                    {favourites.length === 0 ? (
                      <p className="order-favourites-empty">
                        {t("operations.questions.favouritesEmpty")}
                      </p>
                    ) : (
                      favourites.map((item) => {
                        const text = favouriteText(item);
                        return (
                          <div className="order-favourite-row" key={item}>
                            <button
                              className="order-favourite-ask"
                              disabled={askBusy}
                              onClick={() => {
                                setFavouritesOpen(false);
                                setAskText(text);
                                void askOrders(text);
                              }}
                              title={text}
                              type="button"
                            >
                              {text}
                            </button>
                            <button
                              aria-label={t("operations.questions.favouriteRemove", {
                                question: text,
                              })}
                              className="order-ask-chip-remove"
                              onClick={() => removeFavourite(item)}
                              title={t("operations.questions.favouriteRemove", { question: text })}
                              type="button"
                            >
                              ×
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </span>
              <button
                className="button button-primary"
                disabled={askBusy || askText.trim().length < 2}
                type="submit"
              >
                {askBusy ? t("common.working") : t("operations.questions.askButton")}
              </button>
            </form>
          ) : null}
        </div>
        ) : null}
        {aiTab && (askError !== undefined || askResult !== undefined) ? (
          <div aria-live="polite" className="order-questions-answer">
            {askError !== undefined ? (
              <span className="order-questions-answer-error" role="alert">
                {askError}
              </span>
            ) : null}
            {askResult?.unsupported ? (
              <span className="order-questions-answer-note">
                {t("operations.questions.notAboutOrders")}
              </span>
            ) : null}
            {askResult !== undefined && !askResult.unsupported ? (
              <>
                <span className="order-questions-answer-title">
                  {t("operations.questions.understoodAs")}
                </span>
                {askResult.chips
                  // A chip whose filters were since cleared elsewhere is gone.
                  .filter((chip) =>
                    chip.filterKeys.some(
                      (key) => (filters as unknown as Record<string, string>)[key] !== "",
                    ),
                  )
                  .map((chip) => (
                    <span className="order-ask-chip" key={chip.field}>
                      <span className="order-ask-chip-field">
                        {t(`operations.questions.field.${chip.field}`, {
                          defaultValue: chip.field,
                        })}
                        :
                      </span>{" "}
                      {orderAskChipValue(chip, t)}
                      <button
                        aria-label={t("operations.questions.removeChip", {
                          field: t(`operations.questions.field.${chip.field}`, {
                            defaultValue: chip.field,
                          }),
                        })}
                        className="order-ask-chip-remove"
                        onClick={() => removeAskChip(chip)}
                        type="button"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                {askResult.chips.length === 0 ? (
                  <span className="order-questions-answer-note">
                    {t("operations.questions.understoodNothing")}
                  </span>
                ) : null}
                {askResult.notes.map((note) => (
                  <span className="order-questions-answer-note" key={`${note.field}:${note.value}`}>
                    {note.candidates.length === 0
                      ? t("operations.questions.nameNotFound", {
                          field: t(`operations.questions.field.${note.field}`, {
                            defaultValue: note.field,
                          }),
                          value: note.value,
                        })
                      : t("operations.questions.nameAmbiguous", {
                          candidates: note.candidates.join(locale === "ar" ? "، " : ", "),
                          field: t(`operations.questions.field.${note.field}`, {
                            defaultValue: note.field,
                          }),
                          value: note.value,
                        })}
                  </span>
                ))}
              </>
            ) : null}
            {askResult !== undefined && !askResult.unsupported && askedQuestion !== "" ? (
              <button
                aria-pressed={isFavourite(askedQuestion)}
                className="button button-secondary order-questions-favourite"
                onClick={() => toggleFavourite(askedQuestion)}
                type="button"
              >
                {isFavourite(askedQuestion)
                  ? `★ ${t("operations.questions.favouriteSaved")}`
                  : `☆ ${t("operations.questions.favouriteAdd")}`}
              </button>
            ) : null}
            <button
              className="button button-secondary order-questions-answer-clear"
              onClick={() => {
                // An applied answer is undone too: back to the normal list.
                if (askResult !== undefined && !askResult.unsupported) {
                  list.setFilters({
                    ...Object.fromEntries(orderFilterKeys.map((key) => [key, ""])),
                    quickView: "ai",
                  });
                  setGrouping("");
                }
                clearAsk();
                setAskText("");
              }}
              type="button"
            >
              {t("operations.questions.askClear")}
            </button>
          </div>
        ) : null}
        {false ? (
          <section className="card" aria-label={t("operations.quickView.accountant")}>
            <div className="orders-quick-views" role="tablist">
              <button
                className={accountantSection === "collect" ? "active" : undefined}
                onClick={() => setAccountantSection("collect")}
                role="tab"
                type="button"
              >
                {t("operations.accountantCollect")}{" "}
                <span className="tab-count">{accountantCollect.length}</span>
              </button>
              <button
                className={accountantSection === "pay" ? "active" : undefined}
                onClick={() => setAccountantSection("pay")}
                role="tab"
                type="button"
              >
                {t("operations.accountantPay")}{" "}
                <span className="tab-count">
                  {traders.filter((trader) => Number(trader.unsettledNetPayable) > 0).length}
                </span>
              </button>
              <button
                aria-label={t("common.refresh")}
                className="button"
                onClick={() => setAccountantRefreshNonce((current) => current + 1)}
                title={t("common.refresh")}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} /> {t("common.refresh")}
              </button>
            </div>
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>
                      {accountantSection === "collect"
                        ? t("operations.driver")
                        : t("operations.trader")}
                    </th>
                    <th>{t("operations.orderNumber")}</th>
                    <th>{t("operations.amount")}</th>
                    <th>{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {accountantSection === "collect"
                    ? accountantCollect.map((item) => (
                        <tr key={item.id}>
                          <td>{item.assignedDriverName}</td>
                          <td>{item.orderNumber}</td>
                          <td>{formatCurrency(item.amountCollected, "AED", locale)}</td>
                          <td>
                            <button
                              onClick={() =>
                                onNavigate(
                                  collectFromDriverPath({
                                    driverId: item.driverId,
                                    orderIds: [item.id],
                                  }),
                                )
                              }
                              type="button"
                            >
                              {t("operations.accountantCollect")}
                            </button>
                          </td>
                        </tr>
                      ))
                    : traders
                        .filter((trader) => Number(trader.unsettledNetPayable) > 0)
                        .map((trader) => (
                          <tr key={trader.id}>
                            <td>{trader.name}</td>
                            <td>
                              {(accountantPayOrders[trader.id] ?? []).map((order) => (
                                <button
                                  className="order-number-link"
                                  key={order.id}
                                  onClick={() =>
                                    onNavigate(`/orders/${encodeURIComponent(order.orderNumber)}`)
                                  }
                                  type="button"
                                >
                                  {order.serialNumber || order.orderNumber}
                                </button>
                              ))}
                            </td>
                            <td>{formatCurrency(trader.unsettledNetPayable, "AED", locale)}</td>
                            <td>
                              <button
                                onClick={() =>
                                  onNavigate(
                                    `/trader-settlements?traderId=${encodeURIComponent(trader.id)}`,
                                  )
                                }
                                type="button"
                              >
                                {t("operations.accountantPay")}
                              </button>
                            </td>
                          </tr>
                        ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        <>
          <div className="orders-filter-bar">
            <label className="row-status-color-toggle">
              <input
                checked={rowStatusColors}
                onChange={(event) => setRowStatusColors(event.target.checked)}
                type="checkbox"
              />
              {t("operations.rowStatusColors")}
            </label>
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
                // A column of Order / Reference Numbers pasted from Excel stays
                // a comma list instead of being glued into one value.
                onPaste={listPasteHandler(setSearchText)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // The box is not inside a form, but preventDefault keeps this
                  // safe if it is ever moved into one.
                  event.preventDefault();
                  updateFilters({ search: searchText });
                }}
                // Leaving the box (clicking a row, Edit order, anywhere) applies
                // what was typed, so the filter stays until Clear filters
                // instead of being lost when the operator forgets Enter.
                onBlur={() => {
                  if (searchText !== filters.search) updateFilters({ search: searchText });
                }}
                placeholder={t("operations.searchOrdersPlaceholder")}
                title={t("operations.searchOrdersListHint")}
                value={searchText}
              />
            </label>
            <label className="orders-search orders-serial-search">
              <Search aria-hidden="true" size={17} />
              {/* Reference No. only, EXACT (Aiman, 19 Oct 2026): "28" finds
                  reference 28 only -- not serial 28, 4328 or a customer. A
                  comma list or a pasted Excel column matches each exactly. */}
              <span className="sr-only">{t("operations.searchReferenceNumber")}</span>
              <input
                onChange={(event) => setReferenceSearchText(event.target.value)}
                onPaste={listPasteHandler(setReferenceSearchText)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  updateFilters({ referenceNumber: referenceSearchText });
                }}
                onBlur={() => {
                  if (referenceSearchText !== filters.referenceNumber) {
                    updateFilters({ referenceNumber: referenceSearchText });
                  }
                }}
                placeholder={t("operations.searchReferenceNumberPlaceholder")}
                value={referenceSearchText}
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
            <DeliveryStatusMultiSelect
              label={t("operations.deliveryStatus")}
              onChange={(value) => updateFilters({ deliveryStatus: value })}
              value={filters.deliveryStatus}
            />
            {filters.quickView === "cancelled" ||
            selectedDeliveryStatuses(filters.deliveryStatus).includes("cancelled") ||
            filters.cancellationReason !== "" ? (
              <FilterSelect
                label={t("operations.cancellationType")}
                onChange={(value) => updateFilters({ cancellationReason: value })}
                value={filters.cancellationReason}
              >
                {cancellationTypes.map((type) => (
                  <option key={type} value={type}>
                    {t(`operations.cancellationTypes.${type}`)}
                  </option>
                ))}
              </FilterSelect>
            ) : null}
            <FilterSelect
              label={t("operations.workflowStep")}
              onChange={(value) => updateFilters({ workflowStep: value })}
              value={filters.workflowStep}
            >
              {orderWorkflowStepFilters.map((step) => (
                <option key={step} value={step}>
                  {t(`operations.workflowStepFilters.${step}`)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t("operations.orderType")}
              onChange={(value) => updateFilters({ orderType: value })}
              value={filters.orderType}
            >
              <option value="delivery">{t("operations.internalDelivery")}</option>
              <option value="collect_order">{t("operations.collectOrder")}</option>
              <option value="gcc_international">GCC &amp; International</option>
            </FilterSelect>
            <FilterSelect
              label={t("operations.internationalCarrierStage")}
              onChange={(value) => updateFilters({ internationalCarrierStatus: value })}
              value={filters.internationalCarrierStatus}
            >
              <option value="">{t("operations.allInternationalCarrierStages")}</option>
              <option value="ready_for_carrier">
                {t("operations.internationalCarrierStatuses.ready_for_carrier")}
              </option>
              <option value="handed_to_carrier">
                {t("operations.internationalCarrierStatuses.handed_to_carrier")}
              </option>
              <option value="in_transit">
                {t("operations.internationalCarrierStatuses.in_transit")}
              </option>
            </FilterSelect>
            <label className="filter-select filter-combobox-field international-country-filter">
              <span className="sr-only">Third-party shipping company</span>
              <FilterCombobox
                emptyText="No carriers found"
                label="Carrier"
                onChange={(value) => {
                  const option = (carrierFilterOptions ?? []).find(
                    (candidate) => candidate.id === value,
                  );
                  updateFilters({ thirdPartyDeliveryCompanyName: option?.name ?? "" });
                }}
                options={(carrierFilterOptions ?? []).map((carrier) => ({
                  id: carrier.id,
                  label: carrier.name,
                }))}
                placeholder="Carrier"
                value={
                  (carrierFilterOptions ?? []).find(
                    (carrier) => carrier.name === filters.thirdPartyDeliveryCompanyName,
                  )?.id ?? ""
                }
              />
            </label>
            <label className="filter-select filter-combobox-field international-country-filter">
              <span className="sr-only">Destination country</span>
              <FilterCombobox
                emptyText="No countries found"
                label="Country"
                onChange={(value) => {
                  const option = (countryFilterOptions ?? []).find(
                    (candidate) => candidate.id === value,
                  );
                  updateFilters({ destinationCountryName: option?.name ?? "" });
                }}
                options={(countryFilterOptions ?? []).map((country) => ({
                  id: country.id,
                  label: country.name,
                }))}
                placeholder="Country"
                value={
                  (countryFilterOptions ?? []).find(
                    (country) => country.name === filters.destinationCountryName,
                  )?.id ?? ""
                }
              />
            </label>
            <div className="filter-grouping-multi-select" id="grouping-popover-anchor">
              <button
                className="grouping-button"
                onClick={() => {
                  const popover = document.getElementById("grouping-popover");
                  if (popover?.style.display === "none" || !popover?.style.display) {
                    popover!.style.display = "block";
                  } else {
                    popover!.style.display = "none";
                  }
                }}
                type="button"
              >
                <span className="grouping-label">
                  {t("operations.grouping")}
                  {Array.isArray(grouping) && grouping.length > 0 && (
                    <>
                      :{" "}
                      <span className="grouping-values">
                        {grouping
                          .map((d) =>
                            d === "area"
                              ? t("operations.groupByArea", { defaultValue: "Area" })
                              : d === "emirate"
                                ? t("operations.groupByEmirate", { defaultValue: "Emirate" })
                                : d === "trader"
                                  ? t("operations.groupByTrader", { defaultValue: "Trader" })
                                  : d === "driver"
                                    ? t("operations.groupByDriver")
                                    : t("operations.groupByStatus"),
                          )
                          .join(", ")}
                      </span>
                    </>
                  )}
                </span>
                <ChevronDown aria-hidden="true" size={16} style={{ marginLeft: "6px" }} />
              </button>
              <div
                className="grouping-popover"
                id="grouping-popover"
                style={{ display: "none" }}
                onClick={(e) => e.stopPropagation()}
              >
                <label className="grouping-checkbox">
                  <input
                    type="checkbox"
                    checked={Array.isArray(grouping) && grouping.includes("emirate")}
                    onChange={() => toggleGroupingDimension("emirate")}
                  />
                  {t("operations.groupingEmirate")}
                </label>
                <label className="grouping-checkbox">
                  <input
                    type="checkbox"
                    checked={Array.isArray(grouping) && grouping.includes("area")}
                    onChange={() => toggleGroupingDimension("area")}
                  />
                  {t("operations.groupingArea")}
                </label>
                <label className="grouping-checkbox">
                  <input
                    type="checkbox"
                    checked={Array.isArray(grouping) && grouping.includes("trader")}
                    onChange={() => toggleGroupingDimension("trader")}
                  />
                  {t("operations.groupingTrader")}
                </label>
                <label className="grouping-checkbox">
                  <input
                    type="checkbox"
                    checked={Array.isArray(grouping) && grouping.includes("driver")}
                    onChange={() => toggleGroupingDimension("driver")}
                  />
                  {t("operations.groupingDriver")}
                </label>
                <label className="grouping-checkbox">
                  <input
                    type="checkbox"
                    checked={Array.isArray(grouping) && grouping.includes("status")}
                    onChange={() => toggleGroupingDimension("status")}
                  />
                  {t("operations.groupingStatus")}
                </label>
                {grouping !== "" && (
                  <>
                    <div className="grouping-divider" />
                    <button
                      className="grouping-clear-button"
                      onClick={() => {
                        clearAllGrouping();
                        document.getElementById("grouping-popover")!.style.display = "none";
                      }}
                      type="button"
                    >
                      {t("operations.clearGrouping")}
                    </button>
                  </>
                )}
              </div>
            </div>
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
                  viewKey: filters.viewKey,
                  ...(filters.quickView === "delivery" ? { dateMode: "", deliveredOnly: "" } : {}),
                });
                setFilterEmirateId("");
                setFilterArea(undefined);
                // Everything goes, the AI tab's work too: the ready question,
                // the typed question and its answer, and the grouping.
                clearAsk();
                setAskText("");
                setCloseAllStage("idle");
                setGrouping("");
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
                  {t("operations.selectedCount", {
                    count: summary?.selectedCount ?? selectedCount,
                  })}
                </strong>
                <span>
                  {formatCurrency(summary?.selectedAmountToCollect ?? "0", "AED", locale)}
                </span>
              </div>
              {/* Grouped like Aiman's layout (11 Oct 2026): delivery status,
                  Driver, manifest, Trader reports, then copy / clear. In Arabic
                  the first group sits on the right. */}
              <div className="bulk-actions">
                {(canUpdateStatus && (!selectedHasInternational || filters.question === "ready_to_close")) ||
                (canUpdateStatus &&
                  bulkSelectedOrders.some((order) => order.orderType === "gcc_international")) ||
                (canUpdateStatus && filters.quickView === "hold" && !allMatching) ? (
                  <div className="bulk-action-group">
                    {/* Closing is the same for International Orders, so the
                        Ready to close answer keeps Change Status even when
                        one is selected; the server checks every Order. */}
                    {canUpdateStatus &&
                    (!selectedHasInternational || filters.question === "ready_to_close") ? (
                      <button onClick={() => setBulkAction("status")} type="button">
                        <MoreHorizontal aria-hidden="true" size={17} />
                        {t("operations.changeStatus")}
                      </button>
                    ) : null}
                    {canUpdateStatus &&
                    bulkSelectedOrders.some((order) => order.orderType === "gcc_international") ? (
                      <button onClick={() => setBulkAction("carrier")} type="button">
                        {t("operations.internationalCarrierBulkAction")}
                      </button>
                    ) : null}
                    {canUpdateStatus && filters.quickView === "hold" && !allMatching ? (
                      <button onClick={() => setBulkAction("reactivate")} type="button">
                        {t("operations.reactivateHoldOrders")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {(canAssignDriver || canReconcile) && !selectedHasInternational ? (
                  <div className="bulk-action-group">
                    {canAssignDriver && !selectedHasInternational ? (
                      <button onClick={() => setBulkAction("assign")} type="button">
                        <Truck aria-hidden="true" size={17} />
                        {t("operations.assignDriver")}
                      </button>
                    ) : null}
                    {canReconcile && !selectedHasInternational ? (
                      <button
                        onClick={() =>
                          onNavigate(
                            collectFromDriverPath({
                              driverId: bulkSelectedOrders[0]?.assignedDriverId ?? filters.driverId,
                              orderIds: bulkSelectedOrders.map((order) => order.id),
                            }),
                          )
                        }
                        type="button"
                      >
                        <HandCoins aria-hidden="true" size={17} />
                        {t("operations.actions.collectMoney")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {canManifest ? (
                  <div className="bulk-action-group">
                    {canManifest ? (
                      <button onClick={() => setBulkAction("manifest")} type="button">
                        <Printer aria-hidden="true" size={17} />
                        {t("operations.actions.printManifest")}
                      </button>
                    ) : null}
                    {/* Cancelled / Returned to Trader Orders only (Aiman, 13 Oct
                        2026): offered on the Cancelled view, on a Returned
                        delivery-status filter, or when every selected Order
                        is one. The server checks again. */}
                    {canManifest &&
                    (filters.quickView === "cancelled" ||
                      /cancelled|returned_to_trader|returned_to_branch/.test(filters.deliveryStatus) ||
                      (bulkSelectedOrders.length > 0 &&
                        bulkSelectedOrders.every(isReturnedToTraderOrder))) ? (
                      <button onClick={() => setBulkAction("returnedItems")} type="button">
                        <Printer aria-hidden="true" size={17} />
                        {t("operations.actions.printReturnedItems")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="bulk-action-group">
                    <button
                      disabled={bulkSelectedOrders.length < 2}
                      onClick={() =>
                        void traderReportPdf.run(
                          `operations/trader-receivables/bulk-report/pdf?language=${locale}`,
                          "Trader-Reports.pdf",
                          "preview",
                          { orderIds: bulkSelectedOrders.map((order) => order.id) },
                        )
                      }
                      title={t("operations.traderBulkReportHint")}
                      type="button"
                    >
                      <FileText aria-hidden="true" size={17} />
                      {t("operations.actions.traderBulkReport")}
                    </button>
                    <button
                      disabled={!canOpenTraderCollectionReport}
                      onClick={() => void openTraderReport("collection")}
                      title={
                        bulkSelectedOrders.length !== 1
                          ? t("operations.traderReportSelectOne")
                          : t("operations.traderCollectionReportUnavailable")
                      }
                      type="button"
                    >
                      <FileText aria-hidden="true" size={17} />
                      {t("operations.actions.traderCollectionReport")}
                    </button>
                    <button
                      disabled={!canOpenTraderSettlementReport}
                      onClick={() => void openTraderReport("settlement")}
                      title={
                        bulkSelectedOrders.length !== 1
                          ? t("operations.traderReportSelectOne")
                          : t("operations.traderSettlementReportUnavailable")
                      }
                      type="button"
                    >
                      <FileText aria-hidden="true" size={17} />
                      {t("operations.actions.traderSettlementReport")}
                    </button>
                    {canCollectSelectedTraderReceivables ? (
                      <button
                        onClick={() =>
                          onNavigate(
                            selectedTraderReceivableId !== undefined &&
                              selectedTraderReceivableId !== null
                              ? `/trader-receivables?collectReceivableId=${encodeURIComponent(selectedTraderReceivableId)}&returnTo=%2Forders`
                              : `/trader-receivables?collectTraderId=${encodeURIComponent(String(traderReceivableTraderId))}&returnTo=%2Forders`,
                          )
                        }
                        type="button"
                      >
                        <HandCoins aria-hidden="true" size={17} />
                        {t("operations.actions.collectFromTrader")}
                      </button>
                    ) : null}
                </div>
                <div className="bulk-action-group bulk-action-group-plain">
                    <button
                      disabled={allMatching || bulkSelectedOrders.length === 0}
                      onClick={() => void copyNumbers()}
                      type="button"
                    >
                      {t("operations.copyNumbers")}
                    </button>
                    <button className="button-link" onClick={clearSelection} type="button">
                      {t("common.clear")}
                    </button>
                </div>
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
                    {(grouping === "" || grouping.length === 0) && canSelectOrders ? (
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
                  <th>{t("operations.orderNumber")}</th>
                  <th>{t("operations.psystemSerial")}</th>
                  <th>{t("operations.referenceNumber")}</th>
                  <th>{t("operations.trader")}</th>
                  <th>{t("operations.customer")}</th>
                  <th>{t("operations.assignedDriver")}</th>
                  <th>{t("operations.codAmount")}</th>
                  <th>{t("operations.totalDeductions")}</th>
                  <th>{t("operations.amountDueToTrader")}</th>
                  <th>{t("operations.amountToCollect")}</th>
                  <th>{t("operations.deliveryStatus")}</th>
                  <th>{t("operations.accountingColumn")}</th>
                  <th>{t("operations.financialStatusColumn")}</th>
                  <th>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {grouping === "" ? orderItems.map(renderOrderRow) : renderGroupsRecursive(groups)}
                {!loading && orderItems.length === 0 ? (
                  <tr>
                    <td className="empty-state" colSpan={15}>
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
          {(grouping === "" || grouping.length === 0) &&
          pageSelected &&
          !allMatching &&
          // A menu tab's rule lives on the server's list query only; the bulk
          // "every matching Order" selection rebuilds the set from the filters
          // and would not apply it. Explicit row selection still works.
          filters.viewKey === "" &&
          // Not part of the bulk filter selection either; explicit rows only.
          filters.cancellationReason === "" &&
          // Nor is the exact Reference filter: "every matching Order" would
          // otherwise ignore it and select far more than the rows shown.
          filters.referenceNumber === "" &&
          matchingCount > pageIds.length ? (
            <button
              className="select-all-matching"
              onClick={() => {
                setAllMatching(true);
                setSelectedIds(new Set());
              }}
              type="button"
            >
              {t("operations.selectAllMatching", { count: matchingCount })}
            </button>
          ) : null}
          <footer className="orders-pagination">
            <span>
              {hasNarrowingFilters
                ? t("operations.resultCountFilteredScoped", {
                    matching: matchingCount,
                    scope: countScope,
                    total: tabTotalCount,
                  })
                : t("operations.resultCountScoped", {
                    count: tabTotalCount,
                    scope: countScope,
                  })}
            </span>
            <label>
              <span>{t("operations.pageSize")}</span>
              <select
                onChange={(event) => {
                  setPageSize(Number(event.target.value) as 25 | 50 | 100 | 200);
                }}
                value={pageSize}
              >
                {[25, 50, 100, 200].map((size) => (
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
              disabled={page * pageSize >= matchingCount}
              onClick={() => setPage(page + 1)}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={18} />
            </button>
          </footer>
        </>
      </section>
      {createOpen ? (
        <CreateOrderDialog
          api={api}
          permissions={permissions}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) =>
            setCreatedNotice(
              t("operations.orderCreatedNotice", {
                orderNumber: created.orderNumber,
                serialNumber: created.serialNumber ?? "—",
              }),
            )
          }
          onSaved={load}
        />
      ) : null}
      {fastEntryOpen ? (
        <FastOrderEntryDialog
          api={api}
          drivers={drivers}
          emirates={emirates}
          onClose={() => setFastEntryOpen(false)}
          onCreated={(notice) => setCreatedNotice(notice)}
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
          reopenDeliveredOrderId={
            selection.selectionMode === "ids" &&
            selection.orderIds?.length === 1 &&
            bulkSelectedOrders.length === 1 &&
            bulkSelectedOrders[0]?.deliveryStatus === "delivered" &&
            permissions.includes("users_roles.manage")
              ? bulkSelectedOrders[0].id
              : undefined
          }
          selection={selection}
          onClose={() => setBulkAction(undefined)}
          onComplete={async () => {
            setBulkAction(undefined);
            clearSelection();
            await load();
          }}
        />
      ) : null}
      {bulkAction === "carrier" ? (
        <BulkCarrierStatusDialog
          api={api}
          onClose={() => setBulkAction(undefined)}
          onComplete={async () => {
            setBulkAction(undefined);
            clearSelection();
            await load();
          }}
          orders={bulkSelectedOrders}
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
      {bulkAction === "returnedItems" ? (
        <TraderReturnedItemsDialog
          api={api}
          onClose={() => setBulkAction(undefined)}
          selection={manifestSelection}
        />
      ) : null}
      {bulkAction === "reactivate" ? (
        <HoldReactivationDialog
          api={api}
          orders={bulkSelectedOrders}
          onClose={() => setBulkAction(undefined)}
          onComplete={async () => {
            setBulkAction(undefined);
            clearSelection();
            await load();
          }}
        />
      ) : null}
    </>
  );
}

type FastEntryStatus = "draft" | "ready" | "created" | "error" | "excluded";
type FastEntryPaymentCondition = "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";

/** A message the sheet reader returns in both languages. */
interface FastEntrySheetMessage {
  ar: string;
  en: string;
}

/** One line of the operators' daily sheet, matched by the server (fast-entry-sheet.service.ts). */
interface FastEntrySheetRowPayload {
  area: CompanyArea | null;
  areaNote: FastEntrySheetMessage | null;
  pickup: boolean;
  codAmount: string;
  customerAddress: string;
  customerName: string;
  driverId: string | null;
  driverName: string;
  emirateId: string;
  errors: FastEntrySheetMessage[];
  excludedReason: FastEntrySheetMessage | null;
  mobile: string;
  notes: string;
  packageCount: number;
  paymentCondition: FastEntryPaymentCondition;
  referenceNumber: string;
  secondMobile: string;
  sheetRow: number;
  sheetServiceFee: string | null;
  sheetTraderName: string;
  trader: OperationsTraderOption | null;
}

interface FastEntrySheetPayload {
  excludedLines: number;
  rows: FastEntrySheetRowPayload[];
  totalLines: number;
}

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
  /** Who pays: sent on quote and create. Blank on the sheet = Pay by Customer. */
  paymentCondition: FastEntryPaymentCondition;
  secondMobile: string;
  /** Set only when the sheet's Driver name is exactly one active Driver. */
  driverId: string;
  driverName: string;
  /** Rows loaded from an Excel sheet: the line number there, and what it said. */
  sheetRow?: number | undefined;
  sheetAreaText: string;
  sheetTraderName: string;
  /**
   * The delivery fee written on the sheet. While set, validation splits it:
   * the Trader's configured fee, and the rest as Additional fees (a lower
   * sheet fee is used as the fee itself). Cleared once the user edits a fee.
   */
  sheetServiceFee: string;
  feeNote?: string | undefined;
  /** Returned / cancelled line: shown in red and never created. */
  excludedReason?: string | undefined;
  /** The Area was matched in another Emirate than the sheet said (both languages). */
  areaNote?: string | undefined;
  /**
   * "احضار" on the sheet: created as a Collect order (Aiman, 22 Oct 2026) --
   * operational only, no COD, no fees, no Driver.
   */
  pickup?: boolean;
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

/**
 * Keyboard order in Fast Entry: Tab walks only these columns, and Tab on COD
 * goes to the next row's Reference Number (adding a row at the end of the
 * sheet). Other columns stay editable with the mouse.
 */
const fastEntryTabOrder = [
  "referenceNumber",
  "trader",
  "customerName",
  "mobile",
  "emirate",
  "area",
  "codAmount",
] as const;

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
    paymentCondition: "customer_pays_cod_and_fee",
    secondMobile: "",
    driverId: "",
    driverName: "",
    sheetAreaText: "",
    sheetTraderName: "",
    sheetServiceFee: "",
  };
}

/** COD below the fees on a Pay by Customer row: the difference is never collected. */
function fastEntryFeesAboveCod(row: FastEntryRow): { cod: number; fees: number } | undefined {
  if (row.paymentCondition !== "customer_pays_cod_and_fee" || row.status === "created") return undefined;
  const fee = row.serviceFee.trim() || row.resolvedServiceFee.trim();
  if (fee === "") return undefined;
  const cod = parseFastEntryMoney(row.codAmount);
  const serviceFee = parseFastEntryMoney(fee);
  const additional = parseFastEntryMoney(row.additionalFees) ?? 0;
  if (cod === undefined || serviceFee === undefined) return undefined;
  const fees = serviceFee + additional;
  return cod < fees ? { cod, fees } : undefined;
}

/** Errors show in English AND Arabic, whatever the screen language (Aiman, 22 Oct 2026). */
function bothLanguages(message: FastEntrySheetMessage): string {
  return `${message.en}\n${message.ar}`;
}

function fastEntryRowFromSheet(line: FastEntrySheetRowPayload): FastEntryRow {
  const row = createFastEntryRow();
  return {
    ...row,
    areaNote: line.areaNote == null ? undefined : bothLanguages(line.areaNote),
    pickup: line.pickup === true,
    additionalFees: "0.00",
    areaId: line.area?.id ?? "",
    areaOption: line.area ?? undefined,
    codAmount: line.pickup === true ? "0.00" : line.codAmount,
    customerAddress: line.customerAddress,
    customerName: line.customerName,
    driverId: line.driverId ?? "",
    driverName: line.driverName,
    emirateId: line.area?.emirateId ?? line.emirateId,
    excludedReason:
      line.excludedReason === null ? undefined : `${line.excludedReason.en} / ${line.excludedReason.ar}`,
    message: line.errors.length === 0 ? undefined : line.errors.map(bothLanguages).join("\n"),
    mobile: line.mobile,
    notes: line.notes,
    packageCount: String(line.packageCount),
    paymentCondition: line.paymentCondition,
    referenceNumber: line.referenceNumber,
    secondMobile: line.secondMobile,
    sheetAreaText: line.customerAddress,
    sheetRow: line.sheetRow,
    // A Collect order carries no money: no COD and no sheet fee to split.
    sheetServiceFee: line.pickup === true ? "" : (line.sheetServiceFee ?? ""),
    sheetTraderName: line.sheetTraderName,
    status: line.excludedReason !== null ? "excluded" : line.errors.length === 0 ? "draft" : "error",
    traderId: line.trader?.id ?? "",
    traderOption: line.trader ?? undefined,
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function parseFastEntryMoney(value: string, required = false): number | undefined {
  // COD 0 is valid, as in Create Order (e.g. a Pay by Trader row on the daily sheet).
  const parsed = parseMoneyInput(value, { allowZero: true, required });
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

const fastEntryMoneyColumns: ReadonlySet<string> = new Set(["codAmount", "additionalFees"]);
const fastEntryEmptyMoney: ReadonlySet<string> = new Set(["", "0", "0.0", "0.00"]);

/**
 * True when the user entered something in the row. The values the sheet fills
 * in by itself (COD and Additional fees 0.00, Packages 1) do not count; any
 * other typed value does -- including a Serial or Reference Number alone, so a
 * half-filled row is validated and shown with its errors instead of being
 * silently dropped. Empty rows are removed when Create orders is clicked.
 */
function rowHasFastEntryContent(row: FastEntryRow): boolean {
  return fastEntryColumns.some((column) => {
    const value = row[column].trim();
    if (fastEntryMoneyColumns.has(column)) return !fastEntryEmptyMoney.has(value);
    if (column === "packageCount") return value !== "" && value !== "1";
    return value !== "";
  });
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
  drivers = [],
  emirates,
  onClose,
  onCreated,
  onSaved,
}: {
  api: ApiClient;
  /** Active Drivers, for the Driver column (assign now or later). */
  drivers?: readonly OperationsDriver[];
  emirates: readonly Emirate[];
  onClose: () => void;
  /** Called once every filled row was created; the sheet then closes. */
  onCreated?: (notice: string) => void;
  onSaved: () => Promise<void> | void;
  /** Kept for callers; names now follow the screen language instead. */
  textLanguage?: "ar" | "en";
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  // Trader, Emirate and Area names follow the screen language (Aiman, 22 Oct
  // 2026): an Arabic screen lists Arabic names, falling back to English only
  // when a record has no Arabic name.
  const nameLanguage = locale;
  // Row errors in English and Arabic together, whatever the screen language.
  const tEnglish = useMemo(() => i18n.getFixedT("en"), [i18n]);
  const tArabic = useMemo(() => i18n.getFixedT("ar"), [i18n]);
  const both = useCallback(
    (key: string, options: Record<string, unknown> = {}) =>
      `${String(tEnglish(key, options))}\n${String(tArabic(key, options))}`,
    [tArabic, tEnglish],
  );
  const emirateOptions = Array.isArray(emirates) ? emirates : [];
  const fastEntryTraderLabel = useCallback(
    (option: OperationsTraderOption) =>
      localizeName(nameLanguage, { ar: option.nameAr, en: option.nameEn }),
    [nameLanguage],
  );
  const [rows, setRows] = useState<FastEntryRow[]>(() =>
    Array.from({ length: 3 }, () => createFastEntryRow()),
  );
  const fastEntryBodyRef = useRef<HTMLTableSectionElement>(null);
  const [pendingFocus, setPendingFocus] = useState<{ rowId: string; field: string }>();
  const focusFastEntryField = useCallback((rowId: string, field: string): boolean => {
    const target = fastEntryBodyRef.current?.querySelector<HTMLElement>(
      `tr[data-row-id="${rowId}"] [data-fe="${field}"] :is(input, select)`,
    );
    if (target === null || target === undefined) return false;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
    return true;
  }, []);
  useEffect(() => {
    if (pendingFocus === undefined) return;
    if (focusFastEntryField(pendingFocus.rowId, pendingFocus.field)) setPendingFocus(undefined);
  }, [focusFastEntryField, pendingFocus, rows]);
  const fastEntryKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, rowIndex: number) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const field = (event.target as HTMLElement).closest<HTMLElement>("[data-fe]")?.dataset.fe;
    const position = fastEntryTabOrder.indexOf(field as (typeof fastEntryTabOrder)[number]);
    if (position < 0) return; // a column outside the order: normal browser Tab
    let targetRow = rowIndex;
    let targetPosition = position + (event.shiftKey ? -1 : 1);
    if (targetPosition >= fastEntryTabOrder.length) {
      targetRow += 1;
      targetPosition = 0;
    } else if (targetPosition < 0) {
      targetRow -= 1;
      targetPosition = fastEntryTabOrder.length - 1;
    }
    if (targetRow < 0) return;
    const targetField = fastEntryTabOrder[targetPosition]!;
    event.preventDefault();
    const existing = rows[targetRow];
    if (existing !== undefined) {
      // Deferred a tick so a combobox can commit its Tab selection first.
      window.setTimeout(() => focusFastEntryField(existing.id, targetField), 0);
      return;
    }
    // Tab on the last row's COD: add a row and continue there.
    const added = createFastEntryRow();
    setRows((current) => [...current, added]);
    setPendingFocus({ field: targetField, rowId: added.id });
  };
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

  // Serial Numbers are NOT pre-filled when the sheet opens: two users with the
  // sheet open would both be shown 1, 2, 3. A blank Serial is assigned by the
  // server when that row is created; a typed Serial is kept as typed.

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
              status:
                row.status === "created" || row.status === "excluded" ? row.status : "draft",
            }
          : row,
      ),
    );
  };

  const addRows = (count: number) => {
    const safeCount = Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 100) : 5;
    setRows((current) => [
      ...current,
      ...Array.from({ length: safeCount }, () => createFastEntryRow()),
    ]);
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
        if (!rowHasFastEntryContent(row) || row.status === "created" || row.status === "excluded")
          continue;
        const serial = row.serialNumber.trim();
        if (serial !== "") serialCounts.set(serial, (serialCounts.get(serial) ?? 0) + 1);
        const reference = row.referenceNumber.trim();
        if (reference !== "")
          referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1);
      }

      return Promise.all(
        targetRows.map(async (row): Promise<FastEntryRow> => {
          if (!rowHasFastEntryContent(row) || row.status === "created" || row.status === "excluded")
            return row;
          const errors: string[] = [];
          const serial = row.serialNumber.trim();
          const reference = row.referenceNumber.trim();
          const cod = parseFastEntryMoney(row.codAmount, true);
          let additionalFees = parseFastEntryMoney(row.additionalFees);
          let serviceFee =
            row.serviceFee.trim() === "" ? undefined : parseFastEntryMoney(row.serviceFee);
          const packages = parseNumericInput(row.packageCount, {
            allowZero: false,
            required: true,
            wholeNumber: true,
          });

          // A blank Serial is valid: the server assigns it when the row is created.
          if (serial !== "" && (serialCounts.get(serial) ?? 0) > 1)
            errors.push(both("operations.fastEntryDuplicateSerial"));
          if (reference !== "" && (referenceCounts.get(reference) ?? 0) > 1)
            errors.push(both("operations.fastEntryDuplicateReference"));
          if (row.traderId === "") errors.push(both("operations.errors.traderRequired"));
          if (row.customerName.trim() === "")
            errors.push(both("operations.errors.customerNameRequired"));
          if (row.mobile.trim() === "") errors.push(both("operations.errors.mobileRequired"));
          if (row.mobile.trim() !== "" && !isFastEntryMobileValid(row.mobile))
            errors.push(both("operations.fastEntryMobileInvalid"));
          if (row.emirateId === "") errors.push(both("areas.selectEmirate"));
          if (row.areaId === "") errors.push(both("operations.errors.areaRequired"));
          // Address is optional here too, matching the Create Order dialog.
          if (cod === undefined) errors.push(both("operations.errors.codInvalid"));
          if (additionalFees === undefined) errors.push(both("operations.errors.additionalInvalid"));
          if (serviceFee === undefined && row.serviceFee.trim() !== "")
            errors.push(both("operations.errors.overrideFeeInvalid"));
          if (row.serviceFee.trim() !== "" && row.overrideReason.trim() === "")
            errors.push(both("operations.errors.overrideReasonRequired"));
          if (!packages.ok) errors.push(both("operations.errors.packagesInvalid"));

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
                  errors.push(both("operations.fastEntryExistingCustomerAddressMismatch"));
                  customerOption = undefined;
                }
              }
            } catch {
              errors.push(both("operations.fastEntryValidationFailed"));
            }
          }

          if (errors.length === 0 && (serial !== "" || reference !== "")) {
            try {
              const query = new URLSearchParams();
              if (serial !== "") query.set("serialNumber", serial);
              if (reference !== "") query.set("referenceNumber", reference);
              const availability = await api.get<{
                referenceNumberAvailable: boolean;
                serialNumberAvailable: boolean;
              }>(`operations/orders/identifier-availability?${query.toString()}`);
              if (serial !== "" && !availability.serialNumberAvailable)
                errors.push(both("operations.serialNumberExists"));
              if (!availability.referenceNumberAvailable)
                errors.push(both("operations.referenceNumberExists"));
            } catch {
              errors.push(both("operations.fastEntryValidationFailed"));
            }
          }

          if (
            errors.length === 0 &&
            row.pickup !== true &&
            row.traderId !== "" &&
            row.areaId !== "" &&
            cod !== undefined
          ) {
            try {
              // Sheet fee split: the Trader's configured fee, and anything above
              // it as Additional fees. A sheet fee below the configured one is
              // used as the fee itself, with the reason filled in.
              const sheetFee =
                row.sheetServiceFee === "" ? undefined : parseFastEntryMoney(row.sheetServiceFee);
              if (sheetFee !== undefined) {
                const configured = await api.post<OperationsOrderQuote>("operations/orders/quote", {
                  additionalFees: 0,
                  areaId: row.areaId,
                  codAmount: cod,
                  paymentCondition: row.paymentCondition,
                  traderId: row.traderId,
                });
                const configuredFee = Number(configured.serviceFee);
                const money = (value: number) =>
                  formatCurrency(value.toFixed(2), "AED", locale);
                if (sheetFee >= configuredFee) {
                  const extra = Math.round((sheetFee - configuredFee) * 100) / 100;
                  additionalFees = extra;
                  serviceFee = undefined;
                  row = {
                    ...row,
                    additionalFees: extra.toFixed(2),
                    feeNote:
                      extra === 0
                        ? undefined
                        : t("operations.fastEntrySheetFeeSplit", {
                            additional: money(extra),
                            service: money(configuredFee),
                            sheet: money(sheetFee),
                          }),
                    overrideReason: "",
                    serviceFee: "",
                  };
                } else {
                  additionalFees = 0;
                  serviceFee = sheetFee;
                  row = {
                    ...row,
                    additionalFees: "0.00",
                    feeNote: t("operations.fastEntrySheetFeeLower", {
                      service: money(configuredFee),
                      sheet: money(sheetFee),
                    }),
                    overrideReason: t("operations.fastEntrySheetFeeReason"),
                    serviceFee: sheetFee.toFixed(2),
                  };
                }
              }
              const quote = await api.post<OperationsOrderQuote>("operations/orders/quote", {
                additionalFees: additionalFees ?? 0,
                areaId: row.areaId,
                codAmount: cod,
                paymentCondition: row.paymentCondition,
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
              errors.push(resolveApiMessage(requestError, both("operations.quoteFailed")));
            }
          }

          return {
            ...row,
            customerOption,
            message: errors.length === 0 ? t("operations.fastEntryReady") : errors.join("\n"),
            status: errors.length === 0 ? "ready" : "error",
          };
        }),
      );
    },
    [api, both, locale, t],
  );

  const [sheetBusy, setSheetBusy] = useState(false);
  const [addTraderFor, setAddTraderFor] = useState<string>();
  const [addedTrader, setAddedTrader] = useState<{ code: string; id: string; name: string }>();
  const sheetInputRef = useRef<HTMLInputElement>(null);

  const loadSheet = async (file: File) => {
    setSheetBusy(true);
    setMessage(undefined);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await api.postMultipart<FastEntrySheetPayload>(
        "operations/orders/fast-entry/sheet",
        form,
      );
      const loaded = result.rows.map((line) => fastEntryRowFromSheet(line));
      setRows((current) => [
        ...current.filter((row) => row.status === "created" || rowHasFastEntryContent(row)),
        ...loaded,
      ]);
      setMessage(
        t("operations.fastEntrySheetLoaded", {
          errors: loaded.filter((row) => row.status === "error").length,
          excluded: result.excludedLines,
          file: file.name,
          loaded: loaded.length - result.excludedLines,
        }),
      );
    } catch (requestError) {
      setMessage(resolveApiMessage(requestError, t("operations.fastEntrySheetReadFailed")));
    } finally {
      setSheetBusy(false);
      if (sheetInputRef.current !== null) sheetInputRef.current.value = "";
    }
  };

  const downloadTemplate = async (language: "ar" | "en") => {
    try {
      const blob = await api.getBinary(`operations/orders/fast-entry/template?language=${language}`);
      downloadBlob(blob, language === "ar" ? "Fast-Entry-Template-AR.xlsx" : "Fast-Entry-Template-EN.xlsx");
    } catch (requestError) {
      setMessage(resolveApiMessage(requestError, t("operations.fastEntrySheetReadFailed")));
    }
  };

  /**
   * A choice made on one sheet row (Trader, Area) is applied to every other
   * row whose sheet said the same and that has nothing chosen yet.
   */
  const applyToSameSheetText = (
    row: FastEntryRow,
    key: "sheetTraderName" | "sheetAreaText",
    isOpen: (candidate: FastEntryRow) => boolean,
    change: Partial<FastEntryRow>,
  ) => {
    updateRow(row.id, change);
    const text = row[key].trim();
    if (text === "") return;
    setRows((current) =>
      current.map((candidate) =>
        candidate.id !== row.id &&
        candidate[key].trim() === text &&
        isOpen(candidate) &&
        candidate.status !== "created" &&
        candidate.status !== "excluded"
          ? {
              ...candidate,
              ...change,
              message: undefined,
              resolvedServiceFee: "",
              status: "draft",
              submissionKey: createFastEntrySubmissionKey(),
            }
          : candidate,
      ),
    );
  };

  const applyAddedTrader = async (created: { code: string; id: string; name: string }) => {
    const sheetName = addTraderFor;
    setAddTraderFor(undefined);
    setAddedTrader(undefined);
    if (sheetName === undefined || created.id === "") return;
    const page = await api.get<SearchPage<OperationsTraderOption>>(
      `operations/traders/search?search=${encodeURIComponent(created.code)}&limit=10&offset=0`,
    );
    const option = page.items.find((item) => item.id === created.id) ?? page.items[0];
    if (option === undefined) return;
    setRows((current) =>
      current.map((candidate) =>
        candidate.sheetTraderName.trim() === sheetName &&
        candidate.traderId === "" &&
        candidate.status !== "created" &&
        candidate.status !== "excluded"
          ? {
              ...candidate,
              message: undefined,
              resolvedServiceFee: "",
              status: "draft",
              submissionKey: createFastEntrySubmissionKey(),
              traderId: option.id,
              traderOption: option,
            }
          : candidate,
      ),
    );
  };

  const createOrders = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      // Only filled rows are created. Empty rows (nothing typed beyond the
      // sheet's own defaults) are removed from the sheet first, so adding 5
      // rows and filling 3 creates 3 Orders with no errors for the other 2.
      // When nothing at all is filled the sheet is left as it is.
      const filledRows = rows.filter(
        (row) => row.status === "created" || rowHasFastEntryContent(row),
      );
      const hasRowsToCreate = filledRows.some(
        (row) => row.status !== "created" && row.status !== "excluded",
      );
      const sourceRows = hasRowsToCreate ? filledRows : rows;
      if (sourceRows.length !== rows.length) setRows(sourceRows);
      const validated = await validateRows(sourceRows);
      const activeValidatedRows = validated.filter(
        (row) => rowHasFastEntryContent(row) && row.status !== "created" && row.status !== "excluded",
      );
      const rowsWithErrors = activeValidatedRows.filter((row) => row.status === "error");
      if (activeValidatedRows.length === 0) {
        setRows(validated);
        setMessage(t("operations.fastEntryNoRowsToCreate"));
        return;
      }
      if (rowsWithErrors.length > 0) {
        setRows(validated);
        setMessage(both("operations.fastEntryFixRowsBeforeCreate", { count: rowsWithErrors.length }));
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
          const createdOrder = await api.post<OperationsOrder>(
            "operations/orders",
            {
              additionalFees: row.pickup === true ? 0 : additionalFees,
              areaId: row.areaId,
              codAmount: row.pickup === true ? 0 : cod,
              ...(row.pickup === true ? { orderType: "collect_order" } : {}),
              customerAddressId: customerPayload.customerAddressId,
              customerAddress: row.customerAddress.trim(),
              customerId: customerPayload.customerId,
              customerMobileNumber: row.mobile.trim(),
              customerName: row.customerName.trim(),
              customerSecondMobileNumber: row.secondMobile.trim() || undefined,
              driverId: row.driverId === "" || row.pickup === true ? undefined : row.driverId,
              inlineCustomer: customerPayload.inlineCustomer,
              notes: row.notes.trim() || undefined,
              packageCount: packages.ok ? packages.value : 1,
              paymentCondition: row.pickup === true ? undefined : row.paymentCondition,
              referenceNumber: row.referenceNumber.trim() || undefined,
              // Blank is sent as omitted: the server assigns the next Serial now.
              serialNumber: row.serialNumber.trim() === "" ? undefined : row.serialNumber.trim(),
              serviceFee: row.pickup === true ? undefined : serviceFee,
              serviceFeeOverrideReason:
                row.pickup === true || row.serviceFee.trim() === "" ? undefined : row.overrideReason.trim(),
              traderId: row.traderId,
            },
            {
              "X-Idempotency-Key": row.submissionKey,
            },
          );
          nextRows[index] = {
            ...row,
            message: t("operations.fastEntryCreated"),
            // Show the Serial the server actually saved (assigned when blank).
            serialNumber: createdOrder?.serialNumber ?? row.serialNumber,
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
      // A failed row keeps the sheet open so it can be fixed; rows already
      // created stay marked and are not sent again.
      if (stoppedOnCreateError) return;
      const createdNow = nextRows.filter(
        (row, index) => row.status === "created" && validated[index]?.status !== "created",
      );
      const createdCount = nextRows.filter((row) => row.status === "created").length;
      if (onCreated !== undefined) {
        // Everything was created: close the sheet, like Create order does, and
        // tell the user on the Orders list which Serial Numbers were saved.
        onCreated(
          t("operations.fastEntryCreatedNotice", {
            count: createdNow.length,
            serialNumbers: createdNow
              .map((row) => row.serialNumber.trim())
              .filter((serial) => serial !== "")
              .join(", "),
          }),
        );
        onClose();
        return;
      }
      setMessage(t("operations.fastEntryCreatedCount", { count: createdCount }));
    } finally {
      setBusy(false);
    }
  };

  const readyRows = rows.filter((row) => row.status === "ready").length;
  const createdRows = rows.filter((row) => row.status === "created").length;
  const activeRows = rows.filter(
    (row) => rowHasFastEntryContent(row) && row.status !== "created" && row.status !== "excluded",
  );
  const excludedRows = rows.filter((row) => row.status === "excluded").length;

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
              total: rows.length - excludedRows,
            })}
          </span>
        </div>
        <div className="fast-entry-toolbar fast-entry-sheet-toolbar">
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void loadSheet(file);
            }}
            ref={sheetInputRef}
            type="file"
          />
          <button
            className="button"
            disabled={busy || sheetBusy}
            onClick={() => sheetInputRef.current?.click()}
            type="button"
          >
            {sheetBusy ? t("operations.fastEntryLoadingSheet") : t("operations.fastEntryLoadSheet")}
          </button>
          <span className="form-hint">{t("operations.fastEntryTemplate")}</span>
          <button className="link-button" onClick={() => void downloadTemplate("ar")} type="button">
            العربية
          </button>
          <button className="link-button" onClick={() => void downloadTemplate("en")} type="button">
            English
          </button>
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
                <th>{t("operations.paymentCondition")}</th>
                <th>{t("operations.serviceFee")}</th>
                <th>{t("operations.additionalFees")}</th>
                <th>{t("operations.packages")}</th>
                <th>{t("operations.notes")}</th>
                <th>{t("operations.driver")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody ref={fastEntryBodyRef}>
              {rows.map((row, index) => row.status === "excluded" ? (
                <tr className="fast-entry-row-excluded" data-row-id={row.id} key={row.id}>
                  <td>
                    {index + 1}
                    {row.sheetRow === undefined ? null : (
                      <small className="fast-entry-sheet-row">
                        {t("operations.fastEntrySheetRow", { row: row.sheetRow })}
                      </small>
                    )}
                  </td>
                  <td colSpan={15}>
                    <strong>{t("operations.fastEntryExcluded", { reason: row.excludedReason })}</strong>
                    <span className="fast-entry-excluded-detail">
                      {[
                        row.referenceNumber,
                        row.sheetTraderName,
                        row.customerName,
                        row.mobile,
                        row.sheetAreaText,
                        row.codAmount === "" ? "" : formatCurrency(row.codAmount, "AED", locale),
                        row.notes,
                      ]
                        .filter((part) => part.trim() !== "")
                        .join(" · ")}
                    </span>
                  </td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() =>
                        setRows((current) => current.filter((candidate) => candidate.id !== row.id))
                      }
                      type="button"
                    >
                      {t("common.remove")}
                    </button>
                  </td>
                </tr>
              ) : (
                <tr
                  className={`fast-entry-row-${row.status}`}
                  data-row-id={row.id}
                  key={row.id}
                  onKeyDown={(event) => fastEntryKeyDown(event, index)}
                >
                  <td>
                    {index + 1}
                    {row.sheetRow === undefined ? null : (
                      <small className="fast-entry-sheet-row">
                        {t("operations.fastEntrySheetRow", { row: row.sheetRow })}
                      </small>
                    )}
                    {row.pickup === true || row.sheetRow !== undefined ? (
                      <label className="fast-entry-pickup">
                        <input
                          checked={row.pickup === true}
                          onChange={(event) =>
                            updateRow(row.id, {
                              ...(event.target.checked ? { codAmount: "0.00", sheetServiceFee: "" } : {}),
                              pickup: event.target.checked,
                            })
                          }
                          type="checkbox"
                        />
                        {t("operations.fastEntryPickup")}
                      </label>
                    ) : null}
                  </td>
                  <td>
                    <input
                      aria-label={t("operations.serialNumber")}
                      placeholder={t("operations.serialNumberAutoPlaceholder")}
                      value={row.serialNumber}
                      onChange={(event) => updateRow(row.id, { serialNumber: event.target.value })}
                    />
                  </td>
                  <td data-fe="referenceNumber">
                    <input
                      value={row.referenceNumber}
                      onChange={(event) =>
                        updateRow(row.id, { referenceNumber: event.target.value })
                      }
                    />
                  </td>
                  <td
                    className={
                      row.traderId === "" && row.sheetTraderName.trim() !== "" ? "fast-entry-cell-missing" : undefined
                    }
                    data-fe="trader"
                  >
                    <SearchCombobox<OperationsTraderOption>
                      api={api}
                      emptyText={t("operations.noTradersFound")}
                      getLabel={fastEntryTraderLabel}
                      getSelectedLabel={fastEntryTraderLabel}
                      label={t("operations.trader")}
                      onChange={(trader) =>
                        applyToSameSheetText(
                          row,
                          "sheetTraderName",
                          (candidate) => candidate.traderId === "",
                          { traderId: trader?.id ?? "", traderOption: trader },
                        )
                      }
                      path="operations/traders/search"
                      placeholder={t("operations.searchTrader")}
                      selectOnTab
                      value={row.traderOption}
                    />
                    {row.traderId === "" && row.sheetTraderName.trim() !== "" ? (
                      <div className="fast-entry-sheet-hint">
                        <small>{row.sheetTraderName}</small>
                        <button
                          className="link-button"
                          disabled={busy}
                          onClick={() => setAddTraderFor(row.sheetTraderName.trim())}
                          type="button"
                        >
                          {t("operations.fastEntryAddTrader")}
                        </button>
                      </div>
                    ) : null}
                  </td>
                  <td data-fe="customerName">
                    <input
                      value={row.customerName}
                      onChange={(event) => updateRow(row.id, { customerName: event.target.value })}
                    />
                  </td>
                  <td data-fe="mobile">
                    <input
                      value={row.mobile}
                      onChange={(event) => updateRow(row.id, { mobile: event.target.value })}
                    />
                    {row.secondMobile === "" ? null : (
                      <input
                        aria-label={t("operations.secondMobile")}
                        className="fast-entry-override-reason"
                        value={row.secondMobile}
                        onChange={(event) => updateRow(row.id, { secondMobile: event.target.value })}
                      />
                    )}
                  </td>
                  <td data-fe="emirate">
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
                          {localizeName(nameLanguage, { ar: emirate.nameAr, en: emirate.nameEn })}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td
                    className={
                      row.areaId === "" && row.sheetAreaText.trim() !== ""
                        ? "fast-entry-cell-missing"
                        : row.areaNote === undefined
                          ? undefined
                          : "fast-entry-cell-check"
                    }
                    data-fe="area"
                  >
                    <SearchCombobox<CompanyArea>
                      api={api}
                      emptyText={t("areas.noneFound")}
                      getLabel={(area) =>
                        localizeName(nameLanguage, { ar: area.nameAr, en: area.nameEn })
                      }
                      label={t("operations.areaField")}
                      key={`${row.id}-${row.emirateId}`}
                      selectOnTab
                      onChange={(area) =>
                        applyToSameSheetText(
                          row,
                          "sheetAreaText",
                          (candidate) => candidate.areaId === "",
                          {
                            areaId: area?.id ?? "",
                            areaNote: undefined,
                            areaOption: area,
                            emirateId: area?.emirateId ?? row.emirateId,
                          },
                        )
                      }
                      path={
                        row.emirateId === ""
                          ? "configuration/areas/search"
                          : `configuration/areas/search?emirateId=${encodeURIComponent(row.emirateId)}`
                      }
                      placeholder={t("operations.selectArea")}
                      value={row.areaOption}
                    />
                    {row.areaId === "" && row.sheetAreaText.trim() !== "" ? (
                      <div className="fast-entry-sheet-hint">
                        <small>{row.sheetAreaText}</small>
                      </div>
                    ) : null}
                    {row.areaId !== "" && row.areaNote !== undefined ? (
                      <span className="fast-entry-row-note">{row.areaNote}</span>
                    ) : null}
                  </td>
                  <td>
                    <input
                      value={row.customerAddress}
                      onChange={(event) =>
                        updateRow(row.id, { customerAddress: event.target.value })
                      }
                    />
                  </td>
                  <td data-fe="codAmount">
                    <input
                      min="0"
                      step="0.01"
                      type="number"
                      value={row.codAmount}
                      onChange={(event) => updateRow(row.id, { codAmount: event.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={t("operations.paymentCondition")}
                      value={row.paymentCondition}
                      onChange={(event) =>
                        updateRow(row.id, {
                          paymentCondition: event.target.value as FastEntryPaymentCondition,
                        })
                      }
                    >
                      <option value="customer_pays_cod_and_fee">
                        {t("operations.paymentConditions.customer_pays_cod_and_fee")}
                      </option>
                      <option value="customer_pays_cod_trader_pays_fee">
                        {t("operations.paymentConditions.customer_pays_cod_trader_pays_fee")}
                      </option>
                    </select>
                  </td>
                  <td>
                    <input
                      min="0"
                      placeholder={t("operations.fastEntryAutoFee")}
                      step="0.01"
                      type="number"
                      value={row.serviceFee || row.resolvedServiceFee}
                      onChange={(event) =>
                        updateRow(row.id, {
                          feeNote: undefined,
                          serviceFee: event.target.value,
                          sheetServiceFee: "",
                        })
                      }
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
                        updateRow(row.id, {
                          additionalFees: event.target.value,
                          feeNote: undefined,
                          sheetServiceFee: "",
                        })
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
                  <td
                    className={
                      row.driverId === "" && row.driverName.trim() !== ""
                        ? "fast-entry-driver fast-entry-cell-missing"
                        : "fast-entry-driver"
                    }
                  >
                    <select
                      aria-label={t("operations.driver")}
                      onChange={(event) => updateRow(row.id, { driverId: event.target.value })}
                      value={row.driverId}
                    >
                      <option value="">{t("operations.fastEntryDriverLaterOption")}</option>
                      {drivers.map((driver) => (
                        <option key={driver.id} value={driver.id}>
                          {driver.name}
                        </option>
                      ))}
                    </select>
                    {row.driverId === "" && row.driverName.trim() !== "" ? (
                      <small className="fast-entry-sheet-hint">{row.driverName}</small>
                    ) : null}
                  </td>
                  <td>
                    {row.message === undefined ? null : (
                      <span className="fast-entry-row-message">{row.message}</span>
                    )}
                    {row.feeNote === undefined ? null : (
                      <span className="fast-entry-row-note">{row.feeNote}</span>
                    )}
                    {(() => {
                      const short = fastEntryFeesAboveCod(row);
                      return short === undefined ? null : (
                        <span className="fast-entry-row-warning" role="note">
                          {both("operations.fastEntryCodBelowFees", {
                            cod: short.cod.toFixed(2),
                            fees: short.fees.toFixed(2),
                          })}
                        </span>
                      );
                    })()}
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
                <td colSpan={17}>
                  {t("operations.fastEntryTotalCod", {
                    amount: formatCurrency(
                      rows
                        .filter((row) => row.status !== "excluded")
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
      {addTraderFor !== undefined && addedTrader === undefined ? (
        <TraderForm
          api={api}
          initialName={addTraderFor}
          onClose={() => setAddTraderFor(undefined)}
          onSaved={(created) => {
            if (created === undefined) return;
            setAddedTrader({
              code: String(created.code ?? ""),
              id: String(created.id ?? ""),
              name: String(created.name ?? created.nameEn ?? ""),
            });
          }}
          primaryLabel={t("operations.nextSetPricing")}
          title={t("operations.traderInformation")}
        />
      ) : null}
      {addTraderFor !== undefined && addedTrader !== undefined ? (
        <PricingDialog
          api={api}
          onClose={() => void applyAddedTrader(addedTrader)}
          onSaved={() => void applyAddedTrader(addedTrader)}
          primaryLabel={t("operations.savePricingAndUseTrader")}
          title={t("operations.pricingSetup")}
          trader={addedTrader}
        />
      ) : null}
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
  // A report launched from an Arabic screen must be Arabic too. The former
  // Text Language preference could leave the dialog Arabic while silently
  // requesting an English PDF.
  const reportLanguage = locale;
  const cashStatusLabel = useDriverCashStatusLabel();
  const [detail, setDetail] = useState<OperationsOrderDetail>();
  const [historyFilter, setHistoryFilter] = useState("all");
  const [editOpen, setEditOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [reopenDeliveryOpen, setReopenDeliveryOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  const [traderCollectionSummary, setTraderCollectionSummary] = useState<{
    collectionId: string;
    collectionNumber: string;
    amountReceivedNow: string;
    paymentDate: string;
    paymentMethod: "cash" | "bank_transfer";
    traderName: string;
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
  const traderCollectionPdf = useReconciliationPdfActions(api);
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
    if (detail === undefined || detail.traderReceivableStatus !== "collected") {
      setTraderCollectionSummary(undefined);
      return;
    }
    let active = true;
    void api
      .get<{ collectionId: string; collectionNumber: string } | undefined>(
        `operations/trader-receivables/collections-for-order/${detail.id}`,
      )
      .then((link) => {
        if (!active || link === undefined) return undefined;
        return api
          .get<{
            header: {
              collectionNumber: string;
              paymentDate: string;
              paymentMethod: "cash" | "bank_transfer";
              traderName: string;
            };
            summary: { amountReceivedNow: string };
          }>(`operations/trader-receivables/collections/${link.collectionId}/report-data`)
          .then((data) => {
            if (!active) return;
            setTraderCollectionSummary({
              amountReceivedNow: data.summary.amountReceivedNow,
              collectionId: link.collectionId,
              collectionNumber: data.header.collectionNumber,
              paymentDate: data.header.paymentDate,
              paymentMethod: data.header.paymentMethod,
              traderName: data.header.traderName,
            });
          });
      })
      .catch(() => active && setTraderCollectionSummary(undefined));
    return () => {
      active = false;
    };
  }, [api, detail]);

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
      `operations/cash/reconciliations/${collectionSummary.reconciliationId}/pdf?language=${reportLanguage}`,
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
  const openConfirmedTraderCollectionPdf = async (mode: PdfAction) => {
    if (traderCollectionSummary === undefined) return;
    setPdfError(undefined);
    await traderCollectionPdf.run(
      `operations/trader-receivables/collections/${traderCollectionSummary.collectionId}/pdf?language=${reportLanguage}`,
      `Trader-Collection-${traderCollectionSummary.collectionNumber}.pdf`,
      mode,
    );
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
  const canSettle =
    permissions.includes("settlements.create") || permissions.includes("users_roles.manage");
  // "Collect from Trader" means the Trader's open Receivable -- not the
  // customer's COD, which the driver collects. ORD-000920 (14 Oct 2026) showed
  // "Collect from Trader AED 16" (the customer's COD) while the Trader actually
  // owed 516 on RCV-000047.
  const amountFromTrader = Number(detail.traderReceivableOutstanding ?? 0);
  const financialStatus = (() => {
    const amountToCollect = amountFromTrader;
    const amountDueToTrader = Number(detail.traderNetPayable ?? 0);
    const isFree =
      detail.isFreeOrder === true ||
      (amountToCollect === 0 &&
        Number(detail.customerAmountDue ?? 0) === 0 &&
        amountDueToTrader === 0 &&
        Number(detail.codAmount ?? 0) === 0 &&
        Number(detail.serviceFee ?? 0) === 0 &&
        Number(detail.totalDeductions ?? 0) === 0 &&
        Number(detail.vatAmount ?? 0) === 0);
    if (detail.traderReceivableStatus === "collected") return "collected" as const;
    if (isFree) return "free" as const;
    if (amountToCollect > 0 && amountDueToTrader > 0) return "both" as const;
    if (amountToCollect > 0) return "collect" as const;
    if (amountDueToTrader > 0) return "pay" as const;
    return "none" as const;
  })();
  const canReverseSettlement =
    permissions.includes("settlements.reverse") || permissions.includes("users_roles.manage");
  const isOfficeStatusUser =
    permissions.includes("orders.update_delivery_status") ||
    permissions.includes("users_roles.manage");
  // See `OrderRowActions`' identical flag: a Driver User holds
  // `orders.driver_self_service` instead, and may only Hold from Out for
  // Delivery -- never from New or Assigned to Driver, matching the backend's
  // own narrower Driver transition set.
  const isDriverSelfServiceUser =
    !isOfficeStatusUser && permissions.includes("orders.driver_self_service");
  const canHold =
    isOfficeStatusUser || (isDriverSelfServiceUser && detail.deliveryStatus === "out_for_delivery");
  const nextCarrierStatus =
    detail.orderType === "gcc_international" && detail.deliveryStatus !== "delivered"
      ? detail.internationalCarrierStatus === "ready_for_carrier"
        ? "handed_to_carrier"
        : detail.internationalCarrierStatus === "handed_to_carrier"
          ? "in_transit"
          : detail.internationalCarrierStatus === "in_transit"
            ? "delivered"
            : undefined
      : undefined;
  const updateCarrierStatus = async () => {
    if (nextCarrierStatus === undefined) return;
    setStatusBusy(true);
    setError(undefined);
    try {
      await api.patch(`operations/orders/${detail.id}/carrier-status`, {
        status: nextCarrierStatus,
      });
      await load();
    } catch (requestError) {
      setError(message(requestError, t("operations.internationalCarrierStatusUpdateFailed")));
    } finally {
      setStatusBusy(false);
    }
  };
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
          {detail.orderType === "gcc_international" && detail.internationalCarrierStatus ? (
            <span className="status-badge international-carrier-stage">
              {t(`operations.internationalCarrierStatuses.${detail.internationalCarrierStatus}`)}
            </span>
          ) : null}
          {nextCarrierStatus !== undefined && isOfficeStatusUser ? (
            <button
              className="button button-secondary"
              disabled={statusBusy}
              onClick={() => void updateCarrierStatus()}
              type="button"
            >
              {statusBusy
                ? t("common.working")
                : t(`operations.internationalCarrierActions.${nextCarrierStatus}`)}
            </button>
          ) : null}
          {detail.orderType === "gcc_international" &&
          detail.deliveryStatus === "delivered" &&
          detail.traderSettlementStatus === "unsettled" &&
          canSettle ? (
            <button
              className="button button-secondary"
              onClick={() =>
                onNavigate?.(
                  `/trader-settlements?openDialog=new_settlement&orderId=${encodeURIComponent(detail.id)}`,
                )
              }
              type="button"
            >
              {t("operations.actions.moneyOut")}
            </button>
          ) : null}
          {["new", "assigned_to_driver", "out_for_delivery"].includes(detail.deliveryStatus) &&
          canHold ? (
            <button
              className="button button-secondary"
              onClick={() => setHoldOpen(true)}
              type="button"
            >
              {t("operations.actions.hold")}
            </button>
          ) : null}
          {!isDriverSelfServiceUser &&
          (canEditOrder(detail.deliveryStatus) ||
            detail.deliveryStatus === "closed" ||
            detail.deliveryStatus === "delivered") ? (
            <button
              className="button button-secondary"
              onClick={() => setEditOpen(true)}
              type="button"
            >
              <Pencil aria-hidden="true" size={18} />
              {t("operations.editOrder")}
            </button>
          ) : null}
          {detail.deliveryStatus === "delivered" && permissions.includes("users_roles.manage") ? (
            <button
              className="button button-secondary"
              onClick={() => setReopenDeliveryOpen(true)}
              type="button"
            >
              {t("operations.reopenDelivery")}
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
                psystemSerial: t("operations.psystemSerial"),
                printTitle: t("operations.waybill"),
                serialNumber: t("operations.serialNumber"),
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
              onClick={() =>
                onNavigate?.(
                  collectFromDriverPath({
                    driverId: detail.assignedDriverId,
                    orderIds: [detail.id],
                  }),
                )
              }
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
      <section
        className={`order-financial-banner order-financial-banner-${financialStatus}`}
        role="status"
      >
        <strong>{t(`operations.financialBanner.${financialStatus}.title`)}</strong>
        <span>{t(`operations.financialBanner.${financialStatus}.description`)}</span>
        <small>
          {t("operations.financialBanner.amounts", {
            collect: money(amountFromTrader.toFixed(2), locale),
            pay: money(detail.traderNetPayable, locale),
          })}
        </small>
      </section>
      <main className="order-detail-layout">
        <DetailSection
          title={t("operations.orderOverview")}
          rows={[
            [t("operations.serialNumber"), detail.serialNumber ?? t("operations.legacyIdentifier")],
            [t("operations.psystemSerial"), detail.psystemSerial ?? t("operations.notProvided")],
            [
              t("operations.referenceNumber"),
              detail.referenceNumber ?? t("operations.notProvided"),
            ],
            [t("operations.orderDate"), formatDate(detail.orderDate, locale)],
            ...(detail.orderType === "gcc_international"
              ? [
                  [t("operations.orderType"), t("operations.internationalOrderType")] as const,
                  [
                    t("operations.destinationCountry"),
                    detail.destinationCountryName ?? t("operations.notProvided"),
                  ] as const,
                  [
                    t("operations.carrier"),
                    detail.thirdPartyDeliveryCompanyName ?? t("operations.notProvided"),
                  ] as const,
                  [
                    t("operations.internationalCarrierStage"),
                    detail.internationalCarrierStatus
                      ? t(
                          `operations.internationalCarrierStatuses.${detail.internationalCarrierStatus}`,
                        )
                      : t("operations.notProvided"),
                  ] as const,
                ]
              : []),
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
        {detail.orderType === "gcc_international" ? null : (
          <DetailSection
            title={t("operations.driverAndAssignment")}
            rows={[
              [
                t("operations.assignedDriver"),
                detail.assignedDriverName ?? t("operations.unassigned"),
              ],
            ]}
          />
        )}
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
            ...(detail.additionalFees == null || platformQuoteFee(detail) !== null
              ? []
              : [[t("operations.additionalFees"), money(detail.additionalFees, locale)] as const]),
            ...(platformQuoteFee(detail) === null
              ? []
              : [[t("operations.platformFee"), money(platformQuoteFee(detail)!, locale)] as const]),
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
            ...(traderReceivableDue(detail) <= 0
              ? []
              : [
                  [
                    t("operations.traderReceivableDue"),
                    `${money(String(traderReceivableDue(detail)), locale)} — ${t("operations.collectTraderReceivableHint")}`,
                  ] as const,
                ]),
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
            /* The Trader Receivable raised against this Order. It was absent
               from this panel entirely, which is why a fee the Trader had
               already paid looked like it had gone missing: nothing here named
               the Receivable, and a Receivable cleared by settlement netting
               appears on no other screen either. The number links straight to
               it rather than only naming it. */
            ...(detail.traderReceivableNumber == null || detail.traderReceivableNumber.trim() === ""
              ? []
              : [
                  [
                    t("operations.traderReceivableColumn"),
                    <span className="detail-inline" key="trader-receivable">
                      {detail.traderReceivableId == null || onNavigate === undefined ? (
                        detail.traderReceivableNumber
                      ) : (
                        <button
                          className="link-button"
                          onClick={() =>
                            onNavigate(`/trader-receivables/${detail.traderReceivableId}`)
                          }
                          type="button"
                        >
                          {detail.traderReceivableNumber}
                        </button>
                      )}
                      {detail.traderReceivableStatus == null
                        ? null
                        : ` — ${t(
                            `traderReceivables.status${
                              detail.traderReceivableStatus.charAt(0).toUpperCase() +
                              detail.traderReceivableStatus
                                .slice(1)
                                .replace(/_(.)/g, (_, c: string) => c.toUpperCase())
                            }`,
                            { defaultValue: detail.traderReceivableStatus },
                          )}`}
                    </span>,
                  ] as const,
                ]),
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
        <OrderWhatsAppHistory api={api} orderId={String(detail.id)} />
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
        {traderCollectionSummary === undefined ? null : (
          <section className="order-detail-section">
            <h2>{t("operations.traderCollectionDetail")}</h2>
            <dl>
              <div>
                <dt>{t("operations.collectionNumber")}</dt>
                <dd>{traderCollectionSummary.collectionNumber}</dd>
              </div>
              <div>
                <dt>{t("operations.trader")}</dt>
                <dd>{traderCollectionSummary.traderName}</dd>
              </div>
              <div>
                <dt>{t("operations.paymentDate")}</dt>
                <dd>{traderCollectionSummary.paymentDate}</dd>
              </div>
              <div>
                <dt>{t("operations.amountCollected")}</dt>
                <dd>{money(traderCollectionSummary.amountReceivedNow, locale)}</dd>
              </div>
            </dl>
            <div className="modal-actions">
              <button
                onClick={() => void openConfirmedTraderCollectionPdf("preview")}
                type="button"
              >
                {t("operations.previewReport")}
              </button>
              <button onClick={() => void openConfirmedTraderCollectionPdf("print")} type="button">
                {t("common.print")}
              </button>
              <button
                onClick={() => void openConfirmedTraderCollectionPdf("download")}
                type="button"
              >
                {t("operations.downloadPdf")}
              </button>
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
        <CreateOrderDialog
          api={api}
          edit={{ orderId: detail.id, orderNumber: detail.orderNumber }}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await load();
          }}
          permissions={permissions}
          readOnly={detail.deliveryStatus === "closed" || detail.deliveryStatus === "delivered"}
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
      {reopenDeliveryOpen ? (
        <ReasonDialog
          busy={statusBusy}
          label={t("operations.reopenDeliveryReason")}
          onClose={() => setReopenDeliveryOpen(false)}
          onSubmit={(reason) => {
            setStatusBusy(true);
            void api
              .post(`operations/orders/${detail.id}/reopen-delivery`, { reason: reason.trim() })
              .then(async () => {
                setReopenDeliveryOpen(false);
                await load();
              })
              .catch((requestError) =>
                setError(message(requestError, t("operations.reopenDeliveryFailed"))),
              )
              .finally(() => setStatusBusy(false));
          }}
          title={t("operations.reopenDelivery")}
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

function BulkCarrierStatusDialog({
  api,
  onClose,
  onComplete,
  orders,
  selection,
}: {
  api: ApiClient;
  onClose: () => void;
  onComplete: () => Promise<void>;
  orders: readonly OperationsOrder[];
  selection: SelectionPayload;
}) {
  const { t } = useTranslation();
  const [targetStatus, setTargetStatus] = useState<"handed_to_carrier" | "in_transit">(
    "handed_to_carrier",
  );
  const [partial, setPartial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const previous = targetStatus === "handed_to_carrier" ? "ready_for_carrier" : "handed_to_carrier";
  const eligible = orders.filter(
    (order) =>
      order.orderType === "gcc_international" && order.internationalCarrierStatus === previous,
  );
  const ineligible = orders.filter((order) => !eligible.includes(order));
  const reason = (order: OperationsOrder) =>
    order.orderType !== "gcc_international"
      ? t("operations.internationalCarrierDomesticIneligible")
      : t("operations.internationalCarrierPreviousStageRequired", {
          stage: t(`operations.internationalCarrierStatuses.${previous}`),
        });
  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.post("operations/orders/bulk-carrier-status", {
        ...selection,
        allowPartial: partial,
        targetStatus,
      });
      await onComplete();
    } catch (requestError) {
      setError(message(requestError, t("operations.internationalCarrierStatusUpdateFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.internationalCarrierBulkAction")}
      titleId="bulk-carrier-status-title"
    >
      <label className="field">
        <span>{t("operations.internationalCarrierTargetStage")}</span>
        <select
          value={targetStatus}
          onChange={(event) => setTargetStatus(event.target.value as typeof targetStatus)}
        >
          <option value="handed_to_carrier">
            {t("operations.internationalCarrierActions.handed_to_carrier")}
          </option>
          <option value="in_transit">
            {t("operations.internationalCarrierActions.in_transit")}
          </option>
        </select>
      </label>
      <p>
        {t("operations.internationalCarrierBulkSummary", {
          eligible: eligible.length,
          ineligible: ineligible.length,
        })}
      </p>
      {ineligible.length > 0 ? (
        <ul>
          {ineligible.map((order) => (
            <li key={order.id}>
              {order.orderNumber}: {reason(order)}
            </li>
          ))}
        </ul>
      ) : null}
      <label className="checkbox-field">
        <input
          checked={partial}
          onChange={(event) => setPartial(event.target.checked)}
          type="checkbox"
        />
        <span>{t("operations.processEligibleOnly")}</span>
      </label>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={saving || (ineligible.length > 0 && !partial) || eligible.length === 0}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? t("common.working") : t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}

function BulkStatusDialog({
  api,
  onClose,
  onComplete,
  reopenDeliveredOrderId,
  selection,
}: {
  api: ApiClient;
  onClose: () => void;
  onComplete: () => Promise<void>;
  reopenDeliveredOrderId?: string | undefined;
  selection: SelectionPayload;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState("out_for_delivery");
  const [reason, setReason] = useState("");
  const [cancellationType, setCancellationType] =
    useState<CancellationType>(defaultCancellationType);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const reopeningDeliveredOrder =
    reopenDeliveredOrderId !== undefined && status === "out_for_delivery";
  const reasonRequired =
    reopeningDeliveredOrder || ["hold", "cancelled", "returned_to_trader"].includes(status);
  const submit = async () => {
    if (reasonRequired && !reason.trim()) return;
    setSaving(true);
    try {
      if (reopeningDeliveredOrder && reopenDeliveredOrderId !== undefined) {
        await api.post(`operations/orders/${reopenDeliveredOrderId}/reopen-delivery`, {
          reason: reason.trim(),
        });
      } else {
        await api.post("operations/orders/bulk-status", {
          ...selection,
          allowPartial: partial,
          ...(status === "cancelled" ? { cancellationReason: cancellationType } : {}),
          reason: reason.trim() || undefined,
          targetStatus: status,
        });
      }
      await onComplete();
    } catch (requestError) {
      setError(bulkStatusError(requestError, t));
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
      {reopeningDeliveredOrder ? (
        <div className="alert alert-info">{t("operations.reopenDelivery")}</div>
      ) : null}
      {status === "cancelled" ? (
        <CancellationTypeSelect onChange={setCancellationType} value={cancellationType} />
      ) : null}
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

interface ReturnedItemsTraderRow {
  readonly orderCount: number;
  readonly totalPackages: number;
  readonly totalValue: string;
  readonly traderId: string;
  readonly traderName: string;
}

/**
 * Trader Returned Items. One report per Trader (Aiman, 13 Oct 2026): a
 * selection spanning several Traders lists each Trader on its own row with its
 * own Preview / Print / PDF / Excel, and "Download all" saves one separate PDF
 * per Trader -- never one combined PDF.
 */
function TraderReturnedItemsDialog({
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
  const [traders, setTraders] = useState<readonly ReturnedItemsTraderRow[]>();
  const [error, setError] = useState<string>();
  const [busyTrader, setBusyTrader] = useState<string>();
  const pdf = useReconciliationPdfActions(api);

  const loadTraders = useCallback(async () => {
    setError(undefined);
    try {
      const result = await api.post<{ traders: readonly ReturnedItemsTraderRow[] }>(
        "operations/orders/trader-returned-items/traders",
        selection,
      );
      setTraders(result.traders);
    } catch (requestError) {
      setError(message(requestError, t("operations.returnedItemsFailed")));
    }
  }, [api, selection, t]);

  useEffect(() => {
    void loadTraders();
  }, [loadTraders]);

  const stem = (row: ReturnedItemsTraderRow) =>
    `Trader-Returned-Items-${row.traderName.replaceAll(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Trader"}`;
  const query = (row: ReturnedItemsTraderRow) =>
    `language=${locale}&traderId=${encodeURIComponent(row.traderId)}`;

  const run = async (row: ReturnedItemsTraderRow, mode: PdfAction): Promise<boolean> => {
    setError(undefined);
    setBusyTrader(row.traderId);
    const requestError = await pdf.run(
      `operations/orders/trader-returned-items/pdf?${query(row)}`,
      `${stem(row)}.pdf`,
      mode,
      selection,
    );
    setBusyTrader(undefined);
    if (requestError !== undefined) {
      setError(`${row.traderName}: ${message(requestError, t("operations.returnedItemsFailed"))}`);
      return false;
    }
    return true;
  };
  const downloadAll = async () => {
    // One file per Trader, one after another, so each keeps its own name.
    for (const row of traders ?? []) {
      if (!(await run(row, "download"))) return;
    }
  };
  const exportExcel = async (row: ReturnedItemsTraderRow) => {
    setError(undefined);
    setBusyTrader(row.traderId);
    try {
      const blob = await api.postBinary(
        `operations/orders/trader-returned-items/xlsx?${query(row)}`,
        selection,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${stem(row)}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(`${row.traderName}: ${message(requestError, t("operations.returnedItemsFailed"))}`);
    } finally {
      setBusyTrader(undefined);
    }
  };
  const busy = pdf.busy !== undefined || busyTrader !== undefined;

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.actions.printReturnedItems")}
      titleId="trader-returned-items-title"
    >
      {traders === undefined ? (
        error === undefined ? (
          <div className="loading-row">{t("common.loading")}</div>
        ) : (
          <>
            <div className="alert alert-error">{error}</div>
            <div className="modal-actions">
              <button onClick={() => void loadTraders()} type="button">
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
          {traders.length > 1 ? (
            <p className="field-hint">
              {t("operations.returnedItemsPerTrader", { count: traders.length })}
            </p>
          ) : null}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("operations.trader")}</th>
                  <th scope="col">{t("operations.selectedOrders")}</th>
                  <th scope="col">{t("operations.returnedItemsTotalValue")}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {traders.map((row) => (
                  <tr key={row.traderId}>
                    <td>{row.traderName}</td>
                    <td>{row.orderCount}</td>
                    <td>{formatCurrency(row.totalValue, "AED", locale)}</td>
                    <td>
                      <div className="row-actions">
                        <button disabled={busy} onClick={() => void run(row, "preview")} type="button">
                          {busyTrader === row.traderId && pdf.busy === "preview"
                            ? t("common.loading")
                            : t("operations.previewReport")}
                        </button>
                        <button disabled={busy} onClick={() => void run(row, "print")} type="button">
                          {t("common.print")}
                        </button>
                        <button disabled={busy} onClick={() => void run(row, "download")} type="button">
                          {t("operations.downloadPdf")}
                        </button>
                        <button disabled={busy} onClick={() => void exportExcel(row)} type="button">
                          {t("operations.exportExcel")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <div className="modal-actions">
            {traders.length > 1 ? (
              <button disabled={busy} onClick={() => void downloadAll()} type="button">
                {t("operations.returnedItemsDownloadAll", { count: traders.length })}
              </button>
            ) : null}
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
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
  const reportLanguage = locale;
  const [preview, setPreview] = useState<{
    header: { driverMobile: string; driverName: string; orderCount: number };
    summary: { totalCustomerAmountToCollect?: string; totalCod?: string; totalOrders: number };
  }>();
  const [error, setError] = useState<string>();
  const pdf = useReconciliationPdfActions(api);

  const loadPreview = useCallback(async () => {
    setError(undefined);
    try {
      const result = await api.post<{
        header: { driverMobile: string; driverName: string; orderCount: number };
        summary: { totalCustomerAmountToCollect?: string; totalCod?: string; totalOrders: number };
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
        summary: { totalCustomerAmountToCollect?: string; totalCod?: string; totalOrders: number };
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
  const exportExcel = async () => {
    setError(undefined);
    try {
      const blob = await api.postBinary(
        `operations/cash/driver-shipment-manifest/xlsx?language=${reportLanguage}`,
        selection,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const manifestDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Dubai",
      }).format(new Date());
      anchor.download = `Driver-Shipment-Manifest-${(preview?.header.driverName ?? "Driver").replaceAll(/[^A-Za-z0-9]+/g, "-")}-${manifestDate}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
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
              <dt>{t("operations.manifestTotalAmountToCollect")}</dt>
              <dd>
                {formatCurrency(
                  preview.summary.totalCustomerAmountToCollect ?? preview.summary.totalCod ?? "0",
                  "AED",
                  locale,
                )}
              </dd>
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
            <button
              disabled={pdf.busy !== undefined}
              onClick={() => void exportExcel()}
              type="button"
            >
              {t("operations.exportExcel")}
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

function HoldReactivationDialog({
  api,
  orders,
  onClose,
  onComplete,
}: {
  api: ApiClient;
  orders: readonly OperationsOrder[];
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState(() =>
    orders.map((order) => ({
      order,
      newSerialNumber: "",
      newSerialDate: today,
      newStatus: order.assignedDriverId ? "assigned_to_driver" : "in_branch",
    })),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    void api
      .get<{ serialNumber: string }>("operations/orders/next-serial-number")
      .then((result) => {
        const base = Number(result.serialNumber);
        setRows((current) =>
          current.map((row, index) => ({
            ...row,
            newSerialNumber: Number.isFinite(base)
              ? String(base + index)
              : `${result.serialNumber}-${index + 1}`,
          })),
        );
      })
      .catch(() => setError(t("operations.nextSerialFailed")));
  }, [api, t]);
  const batchKeys = rows.map(
    (row) => `${row.newSerialDate}:${row.newSerialNumber.trim().toLowerCase()}`,
  );
  const duplicateKeys = new Set(
    batchKeys.filter(
      (key, index) => key.slice(key.indexOf(":") + 1) !== "" && batchKeys.indexOf(key) !== index,
    ),
  );
  const duplicate = duplicateKeys.size > 0;
  const submit = async () => {
    if (duplicate || rows.some((row) => !row.newSerialNumber.trim()))
      return setError(t("operations.duplicateSerialBatch"));
    setBusy(true);
    setError(undefined);
    try {
      await api.post("operations/orders/hold-reactivation", {
        orders: rows.map((row) => ({
          orderId: row.order.id,
          newSerialNumber: row.newSerialNumber,
          newSerialDate: row.newSerialDate,
          newStatus: row.newStatus,
        })),
      });
      await onComplete();
    } catch (cause) {
      setError(message(cause, t("operations.holdReactivationFailed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.reactivateHoldOrders")}
      titleId="hold-reactivation-title"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>{t("operations.orderNumber")}</th>
              <th>{t("operations.customer")}</th>
              <th>{t("operations.trader")}</th>
              <th>{t("operations.oldSerialNumber")}</th>
              <th>{t("operations.oldSerialDate")}</th>
              <th>{t("operations.newSerialNumber")}</th>
              <th>{t("operations.newSerialDate")}</th>
              <th>{t("operations.newStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.order.id}>
                <td>{row.order.orderNumber}</td>
                <td>{row.order.customerName}</td>
                <td>{row.order.traderName}</td>
                <td>{row.order.serialNumber}</td>
                <td>{row.order.orderDate}</td>
                <td>
                  <input
                    aria-invalid={duplicateKeys.has(batchKeys[index] ?? "")}
                    value={row.newSerialNumber}
                    onChange={(e) =>
                      setRows((current) =>
                        current.map((x, i) =>
                          i === index ? { ...x, newSerialNumber: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  {duplicateKeys.has(batchKeys[index] ?? "") ? (
                    <small className="field-error" role="alert">
                      {t("operations.duplicateSerialInBatch", {
                        serial: row.newSerialNumber,
                      })}
                    </small>
                  ) : null}
                </td>
                <td>
                  <input
                    type="date"
                    value={row.newSerialDate}
                    onChange={(e) =>
                      setRows((current) =>
                        current.map((x, i) =>
                          i === index ? { ...x, newSerialDate: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  <select
                    value={row.newStatus}
                    onChange={(e) =>
                      setRows((current) =>
                        current.map((x, i) =>
                          i === index ? { ...x, newStatus: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="in_branch">{t("statuses.in_branch")}</option>
                    {row.order.assignedDriverId ? (
                      <>
                        <option value="assigned_to_driver">
                          {t("statuses.assigned_to_driver")}
                        </option>
                        <option value="out_for_delivery">{t("statuses.out_for_delivery")}</option>
                      </>
                    ) : null}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirming ? (
        <div className="card">
          <strong>
            {t("operations.selectedOrders")}: {rows.length}
          </strong>
          <p>{t("operations.serialNumbersToChange", { count: rows.length })}</p>
        </div>
      ) : null}
      <div className="modal-actions">
        <button onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        {confirming ? (
          <button
            className="button button-primary"
            disabled={busy || duplicate}
            onClick={() => void submit()}
            type="button"
          >
            {t("operations.confirmAndUpdate")}
          </button>
        ) : (
          <button
            className="button button-primary"
            disabled={duplicate}
            onClick={() => setConfirming(true)}
            type="button"
          >
            {t("common.continue")}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** The Delivery status filter value is one status or several, comma separated. */
function selectedDeliveryStatuses(value: string): string[] {
  return value
    .split(",")
    .map((status) => status.trim())
    .filter((status) => status !== "");
}

/**
 * Delivery status filter: tick one status or several, the same way Grouping
 * works. The value stays a single string ("new,hold") so the URL, saved list
 * state, bulk selection and the manifest all carry it unchanged; the API reads
 * the comma list. Nothing ticked means every status.
 */
function DeliveryStatusMultiSelect({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const selected = new Set(selectedDeliveryStatuses(value));
  const chosen = deliveryStatuses.filter((status) => selected.has(status));

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggle = (status: string) => {
    onChange(
      deliveryStatuses
        .filter((candidate) =>
          candidate === status ? !selected.has(candidate) : selected.has(candidate),
        )
        .join(","),
    );
  };

  return (
    <div className="filter-grouping-multi-select" ref={anchor}>
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
        className="grouping-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="grouping-label">
          {chosen.length === 0 ? (
            t("operations.allLabel", { label })
          ) : (
            <>
              {label}:{" "}
              <span className="grouping-values">
                {chosen.map((status) => t(`statuses.${status}`)).join(", ")}
              </span>
            </>
          )}
        </span>
        <ChevronDown aria-hidden="true" size={16} style={{ marginLeft: "6px" }} />
      </button>
      {open ? (
        <div
          className="grouping-popover"
          role="group"
          aria-label={label}
          style={{ display: "block" }}
        >
          {deliveryStatuses.map((status) => (
            <label className="grouping-checkbox" key={status}>
              <input
                checked={selected.has(status)}
                onChange={() => toggle(status)}
                type="checkbox"
              />
              {t(`statuses.${status}`)}
            </label>
          ))}
          {chosen.length > 0 ? (
            <>
              <div className="grouping-divider" />
              <button
                className="grouping-clear-button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                type="button"
              >
                {t("operations.allLabel", { label })}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
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
  | "cancelled"
  | "collect_order";

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
  const badge = (
    <span className={`status status-${tone}${large ? " order-status-large" : ""}`}>
      {t(`statuses.${order.deliveryStatus}`)}
    </span>
  );
  if (order.deliveryStatus !== "cancelled") return badge;
  // Internal cancellation type under the badge. Orders cancelled before the
  // type existed show "—" rather than a guessed value.
  return (
    <span className="delivery-status-with-note">
      {badge}
      <small className="cancellation-type-note" title={t("operations.cancellationType")}>
        {cancellationTypeLabel(order.cancellationReason, t)}
      </small>
    </span>
  );
}

const cancellationTypes = ["cancel_by_customer", "cancel_by_trader", "cancel_normal"] as const;
type CancellationType = (typeof cancellationTypes)[number];
const defaultCancellationType: CancellationType = "cancel_normal";

function cancellationTypeLabel(value: string | null | undefined, t: TFunction): string {
  if (value === null || value === undefined || value === "") return "—";
  return t(`operations.cancellationTypes.${value}`, { defaultValue: value });
}

/** The fixed cancellation-type list (internal, label only). */
function CancellationTypeSelect({
  onChange,
  value,
}: {
  onChange: (value: CancellationType) => void;
  value: CancellationType;
}) {
  const { t } = useTranslation();
  return (
    <label className="field">
      <span>{t("operations.cancellationType")}</span>
      <select onChange={(event) => onChange(event.target.value as CancellationType)} value={value}>
        {cancellationTypes.map((type) => (
          <option key={type} value={type}>
            {t(`operations.cancellationTypes.${type}`)}
          </option>
        ))}
      </select>
    </label>
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
          {...(inCarrierStages(order)
            ? { internationalCarrierStatus: order.internationalCarrierStatus }
            : {})}
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
      {order.traderReceivableStatus === "collected" ? (
        <span data-trader-receivable-status="collected">
          <span className="financial-status-label">{t("operations.moneyCollectedLabel")}: </span>
          {t("operations.moneyCollectedFromTrader")}
        </span>
      ) : null}
      {Number(order.codAmount ?? 0) === 0 &&
      Number(order.serviceFee ?? 0) === 0 &&
      Number(order.totalDeductions ?? 0) === 0 &&
      Number(order.vatAmount ?? 0) === 0 &&
      Number(order.customerAmountDue ?? 0) === 0 &&
      Number(order.traderNetPayable ?? 0) === 0 ? (
        <span data-financial-status="free-order">
          <span className="financial-status-label">{t("operations.freeOrderLabel")}: </span>
          {t("operations.freeOrderComment")}
        </span>
      ) : null}
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
  | "cancel"
  | "handToCarrier"
  | "startCarrierTransit"
  | "deliverInternational";

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
  returnToBranch: "in_branch",
  returnToTrader: "returned_to_trader",
};

/**
 * The narrower set a Driver User (holding only `orders.driver_self_service`,
 * never the office `orders.update_delivery_status`) may act on for their own
 * assigned Order -- mirrors `driverTransitions` in
 * `OperationsService.changeOrderStatus` exactly, so the UI never offers a
 * move the backend would reject. Assigning/reassigning a Driver, Cancel, and
 * every other office/financial action stay unavailable regardless of
 * delivery status.
 */
const driverSelfServiceActions: Readonly<Record<string, readonly RowAction[]>> = {
  assigned_to_driver: ["markOutForDelivery"],
  out_for_delivery: ["hold", "markDelivered", "returnToBranch"],
  collect_order: ["close"],
};

function closeEligible(order: OperationsOrder): boolean {
  const hasOpenTraderReceivable = Number(order.traderReceivableOutstanding ?? 0) > 0;
  if (hasOpenTraderReceivable) return false;
  if (order.workflowGuidance?.nextActionCode === "close_order") return true;
  const status = order.deliveryStatus;
  const noTraderPaymentDue = Number(order.traderNetPayable) <= 0;
  return (
    ["delivered", "returned_to_trader", "collect_order"].includes(status) &&
    ["reconciled", "not_applicable"].includes(order.driverReconciliationStatus) &&
    (noTraderPaymentDue ||
      ["money_sent_to_trader", "money_received_by_trader", "not_eligible"].includes(
        order.traderSettlementStatus,
      )) &&
    (status !== "returned_to_trader" || order.returnStatus === "returned_to_trader")
  );
}

function traderSettlementActionApplicable(order: OperationsOrder): boolean {
  if (order.workflowGuidance?.nextActionCode === "close_order") return false;
  return Number(order.traderNetPayable) > 0 || order.traderSettlementStatus !== "not_eligible";
}

function availableActions(order: OperationsOrder): readonly RowAction[] {
  if (order.orderType === "gcc_international") {
    if (order.deliveryStatus === "delivered") {
      if (traderSettlementActionApplicable(order) && order.traderSettlementStatus === "unsettled") {
        return ["moneyOut"];
      }
      return closeEligible(order) ? ["close"] : [];
    }
    if (order.internationalCarrierStatus === "ready_for_carrier") return ["handToCarrier"];
    if (order.internationalCarrierStatus === "handed_to_carrier") return ["startCarrierTransit"];
    if (order.internationalCarrierStatus === "in_transit") return ["deliverInternational"];
    return [];
  }
  const recon = order.driverReconciliationStatus;
  const settle = order.traderSettlementStatus;
  const cashDone = ["reconciled", "not_applicable"].includes(recon);
  const settleDone = ["money_sent_to_trader", "money_received_by_trader", "not_eligible"].includes(
    settle,
  );
  const base = ((): readonly RowAction[] => {
    switch (order.deliveryStatus) {
      case "new":
        return order.orderType === "collect_order"
          ? ["assignDriver", "cancel"]
          : ["markInBranch", "assignDriver", "hold", "cancel"];
      case "in_branch":
        return [
          ...(order.assignedDriverId === null
            ? (["assignDriver"] as const)
            : (["markOutForDelivery"] as const)),
          "hold",
          "returnToTrader",
          "cancel",
        ];
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
          ...(settleDone || !traderSettlementActionApplicable(order)
            ? []
            : (["moneyOut"] as const)),
          ...(closeEligible(order) ? (["close"] as const) : []),
        ];
      case "returned_to_branch":
        return [
          ...(order.assignedDriverId === null ? [] : (["markOutForDelivery"] as const)),
          "returnToTrader",
        ];
      case "returned_to_trader":
        return [
          ...(settleDone || !traderSettlementActionApplicable(order)
            ? []
            : (["moneyOut"] as const)),
          ...(closeEligible(order) ? (["close"] as const) : []),
        ];
      case "collect_order":
        return order.assignedDriverId === null ? ["assignDriver"] : ["close"];
      // A Cancelled Order's goods still go back to the Trader (13 Oct 2026).
      case "cancelled":
        return ["returnToTrader"];
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
  // Explicit-ID selection needs no filter fields at all -- matches the "ids"
  // branch of cleanSelectionPayload() above. Spreading the full initialFilters
  // (all ~16 keys, mostly "") used to send several properties the server's
  // OrderSelectionDto does not declare at all (rejected outright by
  // forbidNonWhitelisted) plus empty strings on the ones it does declare as
  // optional UUID/date fields (rejected because @IsOptional only skips an
  // undefined value, not a defined-but-empty one) -- collapsing to the
  // generic "Request validation failed." on every single-Order quick action
  // (Assign Driver, and anything else built on this helper).
  return { orderIds: [orderId], selectionMode: "ids" };
}

/**
 * The ONE authoritative Driver Collection workflow (New Collection, on the
 * Driver Collections screen) with whichever Driver/Order context is already
 * known here carried in. That screen re-validates every Order's eligibility
 * itself against the live backend -- this never decides eligibility, it only
 * saves the operator from re-selecting what they already picked. An Order
 * that turns out to be no longer eligible is reported there, not here.
 */
function collectFromDriverPath(context: {
  readonly driverId?: string | null | undefined;
  readonly orderIds: readonly string[];
  readonly returnTo?: string | undefined;
}): string {
  const query = new URLSearchParams({
    openDialog: "collect_money",
    returnTo: context.returnTo ?? "/orders",
  });
  if (context.driverId) query.set("driverId", context.driverId);
  if (context.orderIds.length > 0) query.set("orderIds", context.orderIds.join(","));
  return `/drivers?${query.toString()}`;
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
  workflowRequest?:
    { readonly dialog: string; readonly suggestedStatus: string | null } | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reasonFor, setReasonFor] = useState<RowAction>();
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [suggestedStatus, setSuggestedStatus] = useState<string>();
  const statusOpenTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [viewCollectionId, setViewCollectionId] = useState<string>();
  const [viewCollectionBusy, setViewCollectionBusy] = useState(false);
  /** The request object already acted on, so a re-render cannot replay it. */
  const workflowRequestHandled = useRef<object | null>(null);
  const canAssign =
    permissions.includes("orders.assign_driver") || permissions.includes("users_roles.manage");
  const isOfficeStatusUser =
    permissions.includes("orders.update_delivery_status") ||
    permissions.includes("users_roles.manage");
  // A Driver User holds `orders.driver_self_service` instead of the office
  // permission above -- never both, by construction of the Driver role. The
  // Order list is already scoped to the Driver's own assigned Orders, so
  // `canUpdateStatus` may be true here, but WHICH actions are offered is
  // still narrowed below to `driverSelfServiceActions`, matching the
  // backend's own narrower Driver transition set exactly.
  const isDriverSelfServiceUser =
    !isOfficeStatusUser && permissions.includes("orders.driver_self_service");
  const canUpdateStatus = isOfficeStatusUser || isDriverSelfServiceUser;
  const canReconcile =
    permissions.includes("reconciliations.create") || permissions.includes("users_roles.manage");
  const canSettle =
    permissions.includes("settlements.create") || permissions.includes("users_roles.manage");
  const actions = availableActions(order).filter((action) => {
    if (action === "assignDriver") return canAssign;
    if (action === "collectMoney") return canReconcile;
    if (action === "moneyOut") return canSettle;
    if (!canUpdateStatus) return false;
    if (isDriverSelfServiceUser) {
      return (driverSelfServiceActions[order.deliveryStatus] ?? []).includes(action);
    }
    return true;
  });
  const detailsPath = `/orders/${encodeURIComponent(order.orderNumber)}`;
  const workflowReturnPath = "/orders";

  useEffect(
    () => () => {
      if (statusOpenTimerRef.current !== undefined) clearTimeout(statusOpenTimerRef.current);
    },
    [],
  );

  const openStatusAfterActionsClose = (target: string) => {
    setOpen(false);
    setSuggestedStatus(target);
    if (statusOpenTimerRef.current !== undefined) clearTimeout(statusOpenTimerRef.current);
    // Do not close one native top-layer dialog and open another in the same
    // React commit. On Chromium that can intermittently leave statusOpen=true
    // without the replacement dialog being promoted, making subsequent clicks
    // appear dead until a reload resets the row state.
    statusOpenTimerRef.current = setTimeout(() => {
      statusOpenTimerRef.current = undefined;
      setStatusOpen(true);
    }, 0);
  };

  const traderSettlementPath = () => {
    const guidance = order.workflowGuidance;
    const query = new URLSearchParams(
      guidance?.nextActionRoute === "/trader-settlements"
        ? guidance.nextActionParams
        : { openDialog: "new_settlement", orderId: order.id, orderNumber: order.orderNumber },
    );
    query.set("returnTo", workflowReturnPath);
    return `/trader-settlements?${query.toString()}`;
  };

  const patchStatus = async (
    status: string,
    reason?: string,
    cancellationReason?: CancellationType,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`operations/orders/${order.id}/status`, {
        ...(cancellationReason === undefined ? {} : { cancellationReason }),
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

  const patchCarrierStatus = async (status: "handed_to_carrier" | "in_transit" | "delivered") => {
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`operations/orders/${order.id}/carrier-status`, { status });
      setOpen(false);
      await onChanged();
    } catch (requestError) {
      setError(message(requestError, t("operations.internationalCarrierStatusUpdateFailed")));
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
    if (action === "handToCarrier") {
      void patchCarrierStatus("handed_to_carrier");
      return;
    }
    if (action === "startCarrierTransit") {
      void patchCarrierStatus("in_transit");
      return;
    }
    if (action === "deliverInternational") {
      void patchCarrierStatus("delivered");
      return;
    }
    if (action === "assignDriver") {
      setOpen(false);
      setAssignOpen(true);
      return;
    }
    if (action === "collectMoney") {
      setOpen(false);
      onNavigate(
        collectFromDriverPath({
          driverId: order.assignedDriverId,
          orderIds: [order.id],
          returnTo: workflowReturnPath,
        }),
      );
      return;
    }
    if (action === "viewCollection") {
      setOpen(false);
      void openViewCollection();
      return;
    }
    if (action === "moneyOut") {
      setOpen(false);
      onNavigate(traderSettlementPath());
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
      openStatusAfterActionsClose(target);
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
            {!isDriverSelfServiceUser &&
            (canEditOrder(order.deliveryStatus) ||
              order.deliveryStatus === "closed" ||
              order.deliveryStatus === "delivered") ? (
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
                (action === "markDelivered" || action === "markOutForDelivery") &&
                order.assignedDriverId === null;
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
                        : undefined
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
          onSubmit={(reason, cancellationReason) => {
            const target = actionTargetStatus[reasonFor];
            if (target !== undefined) void patchStatus(target, reason, cancellationReason);
          }}
          title={t(`operations.actions.${reasonFor}`)}
          withCancellationType={reasonFor === "cancel"}
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
        <CreateOrderDialog
          api={api}
          edit={{ orderId: order.id, orderNumber: order.orderNumber }}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await onChanged();
          }}
          permissions={permissions}
          readOnly={order.deliveryStatus === "closed" || order.deliveryStatus === "delivered"}
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
  withCancellationType = false,
}: {
  busy: boolean;
  label: string;
  onClose: () => void;
  onSubmit: (reason: string, cancellationReason?: CancellationType) => void;
  title: string;
  /** Cancel only: also ask for the fixed cancellation type (default Cancel Normal). */
  withCancellationType?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [cancellationType, setCancellationType] =
    useState<CancellationType>(defaultCancellationType);
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={title}
      titleId="row-reason-title"
    >
      {withCancellationType ? (
        <CancellationTypeSelect onChange={setCancellationType} value={cancellationType} />
      ) : null}
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
          onClick={() =>
            withCancellationType ? onSubmit(reason, cancellationType) : onSubmit(reason)
          }
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

function DetailSection({
  rows,
  title,
}: {
  // ReactNode, not string: a row may carry a link (the Trader Receivable
  // number opens its own screen) rather than plain text.
  rows: readonly (readonly [string, React.ReactNode])[];
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
  readonly level: number;
  readonly orders: readonly OperationsOrder[];
  readonly children: readonly VisibleOrderGroup[];
}

function groupVisibleOrders(
  orders: readonly OperationsOrder[],
  grouping: OrderGrouping,
  t: TFunction,
  locale: "ar" | "en",
  areaEmirateMap?: Map<string, { code: string; name: string }>,
): readonly VisibleOrderGroup[] {
  if (grouping === "" || grouping.length === 0) return [];

  const statusOrder = new Map<string, number>(
    visibleOrderStatuses.map((status, index) => [status, index]),
  );

  const getGroupLabel = (dimension: string, order: OperationsOrder): string => {
    switch (dimension) {
      case "area": {
        const areaName = localizeName(locale, {
          ar: order.areaNameAr,
          en: order.areaNameEn ?? order.areaName,
        });
        const localizedAreaName = areaName || t("operations.unknown");
        let emirateInfo: { code: string; name: string } | undefined;

        const emirateName = localizeName(locale, {
          ar: order.emirateNameAr,
          en: order.emirateNameEn,
        });
        if (emirateName !== "") {
          emirateInfo = {
            code: emirateName.substring(0, 3).toUpperCase(),
            name: emirateName,
          };
        } else if (areaEmirateMap) {
          emirateInfo = areaEmirateMap.get(localizedAreaName) ?? areaEmirateMap.get(order.areaName);
        }

        // If we found emirate info, use the full format; otherwise just show area
        if (emirateInfo) {
          return `${emirateInfo.name} - ${localizedAreaName}`;
        }
        return localizedAreaName;
      }
      case "emirate": {
        const emirateName = localizeName(locale, {
          ar: order.emirateNameAr,
          en: order.emirateNameEn,
        });
        if (emirateName) return emirateName;
        return (
          areaEmirateMap?.get(order.emirateId ?? "")?.name ??
          areaEmirateMap?.get(order.areaId ?? "")?.name ??
          areaEmirateMap?.get(order.areaName ?? "")?.name ??
          t("operations.unknown")
        );
      }
      case "trader":
        return order.traderName ?? t("operations.unknown");
      case "driver":
        return order.assignedDriverName ?? t("operations.unassigned");
      case "status":
        return orderStatusLabel(t, deriveOrderStatus(order).key);
      default:
        return t("operations.unknown");
    }
  };

  const getGroupKey = (dimension: string, order: OperationsOrder): string => {
    switch (dimension) {
      case "area":
        return `area:${order.areaId ?? order.areaName ?? "unknown"}`;
      case "emirate":
        return `emirate:${order.emirateId ?? order.emirateNameEn ?? order.emirateNameAr ?? areaEmirateMap?.get(order.areaId ?? "")?.code ?? areaEmirateMap?.get(order.areaName ?? "")?.code ?? "unknown"}`;
      case "trader":
        return `trader:${order.traderName ?? "unknown"}`;
      case "driver":
        return `driver:${order.assignedDriverId ?? "unassigned"}`;
      case "status":
        return `status:${deriveOrderStatus(order).key}`;
      default:
        return "unknown";
    }
  };

  const buildHierarchy = (
    items: readonly OperationsOrder[],
    dimensions: string[],
    level: number,
  ): VisibleOrderGroup[] => {
    if (level >= dimensions.length) return [];

    const grouped = new Map<string, OperationsOrder[]>();
    for (const order of items) {
      const key = getGroupKey(dimensions[level]!, order);
      const existing = grouped.get(key) ?? [];
      existing.push(order);
      grouped.set(key, existing);
    }

    const result = [...grouped.entries()].map(([key, groupedOrders]) => {
      const isLeaf = level === dimensions.length - 1;
      return {
        key,
        label: getGroupLabel(dimensions[level]!, groupedOrders[0]!),
        level,
        orders: isLeaf ? groupedOrders : [],
        children: isLeaf ? [] : buildHierarchy(groupedOrders, dimensions, level + 1),
      };
    });

    // Sort based on dimension
    const dimension = dimensions[level];
    return result.sort((left, right) => {
      if (dimension === "status") {
        // Read the status off the group key -- `getGroupKey` above writes
        // `status:<derived key>`, so the group already carries it and no member
        // Order has to be hunted down again.
        //
        // The previous form, `deriveOrderStatus(left.children[0]?.orders[0] ??
        // left.orders[0]!)`, blanked the whole Orders page. A non-leaf group
        // holds no Orders of its own (`orders: isLeaf ? groupedOrders : []`),
        // and with three or more grouping dimensions its children are non-leaf
        // too -- so `children[0].orders[0]` was undefined, `orders[0]` was
        // undefined, and the non-null assertion handed `undefined` to
        // deriveOrderStatus(), which threw inside Array.sort. Grouping by
        // Status plus two more dimensions was enough to trigger it.
        const leftStatus = left.key.slice("status:".length);
        const rightStatus = right.key.slice("status:".length);
        return (statusOrder.get(leftStatus) ?? 999) - (statusOrder.get(rightStatus) ?? 999);
      }
      if (dimension === "driver") {
        if (left.key === "driver:unassigned") return 1;
        if (right.key === "driver:unassigned") return -1;
      }
      return left.label.localeCompare(right.label);
    });
  };

  return buildHierarchy(orders, grouping as string[], 0);
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
function traderReceivableDue(detail: OperationsOrderDetail): number {
  const totalDeductions = Number(detail.totalDeductions ?? 0);
  const codAmount = Number(detail.codAmount ?? 0);
  return Math.max(totalDeductions - codAmount, 0);
}

function platformQuoteFee(detail: OperationsOrderDetail): string | null {
  if (!detail.serviceFeeOverrideReason?.startsWith("Platform customer quote ")) return null;
  const additionalFees = Number(detail.additionalFees ?? 0);
  if (Number.isFinite(additionalFees) && additionalFees > 0) return additionalFees.toFixed(2);
  const inferredFee =
    Number(detail.companyRevenue) -
    Number(detail.serviceFee) -
    Number(detail.serviceFeeVatAmount ?? 0);
  return Number.isFinite(inferredFee) && inferredFee > 0 ? inferredFee.toFixed(2) : null;
}
function money(value: string, locale: "ar" | "en"): string {
  return formatCurrency(value, "AED", locale);
}
function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.details === undefined || error.details.length === 0
      ? error.message
      : `${error.message}\n${error.details.join("\n")}`;
  }
  return error instanceof Error ? error.message : fallback;
}

function bulkStatusError(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError) || error.code !== "bulk_status_ineligible") {
    return message(error, t("operations.bulkActionFailed"));
  }
  const heading = t("operations.errors.bulkStatusIneligible");
  const details = (error.details ?? []).map((detail) => {
    const separator = detail.indexOf(":");
    const orderNumber = separator < 0 ? detail : detail.slice(0, separator).trim();
    const reason = separator < 0 ? "" : detail.slice(separator + 1).trim();
    const transition = /^Order is (\S+) and cannot move to (\S+)$/.exec(reason);
    if (transition !== null) {
      return t("operations.errors.bulkStatusTransitionDetail", {
        from: t(`statuses.${transition[1]}`),
        orderNumber,
        to: t(`statuses.${transition[2]}`),
      });
    }
    if (reason === "A Driver must be assigned before this Order can be delivered.") {
      return `${orderNumber}: ${t("operations.driverRequiredForDelivery")}`;
    }
    if (reason === "A Driver must be assigned before this Order can be moved Out for Delivery.") {
      return `${orderNumber}: ${t("operations.driverRequiredForDispatch")}`;
    }
    // Never leak a server-authored English sentence into Arabic UI. The code
    // and Order number remain enough for the operator to identify the row;
    // known reasons above retain the more specific explanation.
    return t("operations.errors.bulkStatusOrderIneligible", { orderNumber });
  });
  return details.length === 0 ? heading : `${heading}\n${details.join("\n")}`;
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
  if (event.eventType === "order.zero_service_fee") return t("operations.audit.zeroServiceFee");
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

const orderWorkflowStepFilters = [
  "complete",
  "collect_from_driver",
  "collect_from_trader",
  "settle_trader",
] as const;

const deliveryStatuses = [
  "new",
  "in_branch",
  "assigned_to_driver",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_trader",
  "cancelled",
  "closed",
  "collect_order",
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
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;
