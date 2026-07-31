import type { ApiClient } from "../../api/api-client.js";
import type { AccountingPage, AccountingRecord } from "./accounting-types.js";

const root = "operations/accounting";

function queryString(input: Readonly<Record<string, unknown>> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((item) => query.append(key, String(item)));
    else query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function mutationHeaders(key?: string): Readonly<Record<string, string>> {
  return { "x-idempotency-key": key ?? globalThis.crypto.randomUUID() };
}

export class AccountingApi {
  public constructor(private readonly api: ApiClient) {}

  public get<T>(path: string, filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.api.get<T>(`${root}/${path}${queryString(filters)}`, signal);
  }

  public post<T>(path: string, body?: unknown, key?: string) {
    return this.api.post<T>(`${root}/${path}`, body, mutationHeaders(key));
  }

  public patch<T>(path: string, body?: unknown, key?: string) {
    return this.api.patch<T>(`${root}/${path}`, body, mutationHeaders(key));
  }

  public put<T>(path: string, body?: unknown) {
    return this.api.put<T>(`${root}/${path}`, body, mutationHeaders());
  }

  public delete<T>(path: string) {
    return this.api.delete<T>(`${root}/${path}`);
  }

  public binary(path: string, signal?: AbortSignal) {
    return this.api.getBinary(`${root}/${path}`, signal);
  }

  public configuration(signal?: AbortSignal) {
    return this.get<AccountingRecord>("configuration", undefined, signal);
  }
  public configurationReadiness(signal?: AbortSignal) {
    return this.get<AccountingRecord>("configuration/completeness", undefined, signal);
  }
  public automaticPostingStatus(signal?: AbortSignal) {
    return this.get<AccountingRecord>("automatic-posting/status", undefined, signal);
  }
  public automaticPostingReadiness(signal?: AbortSignal) {
    return this.get<AccountingRecord>("automatic-posting/readiness", undefined, signal);
  }
  public mappingSuggestions(effectiveOn?: string, signal?: AbortSignal) {
    return this.get<AccountingRecord>("setup/mapping-suggestions", { effectiveOn }, signal);
  }
  public mappingIssues(effectiveOn?: string, signal?: AbortSignal) {
    return this.get<AccountingRecord>("setup/mapping-issues", { effectiveOn }, signal);
  }
  public zeroOpeningStatus(effectiveOn?: string, signal?: AbortSignal) {
    return this.get<AccountingRecord>("setup/zero-opening", { effectiveOn }, signal);
  }
  public setupAreas(signal?: AbortSignal) {
    return this.get<AccountingRecord>("setup/automatic-posting/areas", undefined, signal);
  }
  public dashboardActions(signal?: AbortSignal) {
    return this.get<AccountingRecord>("dashboard/actions", undefined, signal);
  }
  public financialSnapshot(signal?: AbortSignal) {
    return this.get<AccountingRecord>("dashboard/financial-snapshot", undefined, signal);
  }
  public recentActivity(signal?: AbortSignal) {
    return this.get<AccountingRecord>("dashboard/recent-activity", undefined, signal);
  }
  public accounts(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<AccountingPage>("accounts", filters, signal);
  }
  public accountHierarchy(signal?: AbortSignal) {
    return this.get<readonly AccountingRecord[]>("accounts/hierarchy", undefined, signal);
  }
  public fiscalYears(signal?: AbortSignal) {
    return this.get<readonly AccountingRecord[]>("fiscal-years", undefined, signal);
  }
  public fiscalPeriods(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<readonly AccountingRecord[]>("fiscal-periods", filters, signal);
  }
  public journals(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<AccountingPage>("journals", filters, signal);
  }
  public openingBalances(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<AccountingPage>("opening-balances", filters, signal);
  }
  public events(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<AccountingPage>("events", filters, signal);
  }
  public expenses(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<AccountingPage>("general-expenses", filters, signal);
  }
  public movements(filters?: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.get<AccountingPage>("cash-bank/movements", filters, signal);
  }
}

export function accountingQueryKey(
  companyId: string,
  resource: string,
  identity: Readonly<Record<string, unknown>> = {},
): string {
  const stable = Object.entries(identity)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(["accounting", companyId, resource, stable]);
}
