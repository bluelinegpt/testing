const ORDER_LIST_STATE_STORAGE_PREFIX = "blueline.orders.list-state.v1";

const listStateParameterNames = new Set([
  "areaId",
  "businessDateFrom",
  "businessDateTo",
  "dateFrom",
  "dateMode",
  "dateTo",
  "deliveryDateFrom",
  "deliveryDateTo",
  "deliveryStatus",
  "deliveredOnly",
  "destinationCountryName",
  "direction",
  "driverId",
  "emirateId",
  "internationalCarrierStatus",
  "orderType",
  "page",
  "pageSize",
  "quickView",
  "referenceNumber",
  "search",
  "serialNumber",
  "sort",
  "thirdPartyDeliveryCompanyName",
  "traderId",
  "workflowStep",
]);

const groupingDimensions = ["area", "emirate", "trader", "driver", "status"] as const;
export type OrdersGroupingDimension = (typeof groupingDimensions)[number];

export interface OrdersListSnapshot {
  readonly search: string;
  readonly grouping: readonly OrdersGroupingDimension[];
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function ordersListStateStorageKey(companyId: string, userId: string): string {
  return `${ORDER_LIST_STATE_STORAGE_PREFIX}:${encodeURIComponent(companyId)}:${encodeURIComponent(userId)}`;
}

export function hasOrdersListState(parameters: URLSearchParams): boolean {
  return [...parameters.keys()].some((key) => listStateParameterNames.has(key));
}

export function restoreOrdersListSearch(
  currentSearch: string,
  savedSearch: string,
): string {
  const current = new URLSearchParams(currentSearch);
  const saved = new URLSearchParams(savedSearch);
  for (const [key, value] of saved) {
    if (listStateParameterNames.has(key) && !current.has(key)) current.set(key, value);
  }
  const query = current.toString();
  return query === "" ? "" : `?${query}`;
}

export function removeOrdersListSearch(currentSearch: string): string {
  const current = new URLSearchParams(currentSearch);
  for (const key of listStateParameterNames) current.delete(key);
  const query = current.toString();
  return query === "" ? "" : `?${query}`;
}

export function readOrdersListSnapshot(
  storage: StorageLike,
  key: string,
): OrdersListSnapshot | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as { search?: unknown; grouping?: unknown };
    const grouping = Array.isArray(record.grouping)
      ? record.grouping.filter(
          (item): item is OrdersGroupingDimension =>
            typeof item === "string" && groupingDimensions.includes(item as OrdersGroupingDimension),
        )
      : [];
    return {
      search: typeof record.search === "string" ? record.search : "",
      grouping,
    };
  } catch {
    return undefined;
  }
}

export function writeOrdersListSnapshot(
  storage: StorageLike,
  key: string,
  search: string,
  grouping: readonly OrdersGroupingDimension[],
): void {
  const parameters = new URLSearchParams(search);
  const persisted = new URLSearchParams();
  for (const [name, value] of parameters) {
    if (listStateParameterNames.has(name)) persisted.set(name, value);
  }
  try {
    storage.setItem(key, JSON.stringify({ grouping, search: persisted.toString() }));
  } catch {
    // Persistence is best-effort: Orders remains fully usable if browser
    // storage is unavailable or the user is in private browsing.
  }
}
