import { platformConfiguration } from "../config/environment.js";

/**
 * The Platform Portal's only way to reach the API.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO TOKEN IN THIS FILE, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 *
 * The Delivery Portal's client carries an optional bearer token alongside the
 * cookie, because API clients that predate the cookie still use one. This
 * client has no such field, no `setAccessToken`, and nothing to persist. The
 * session lives entirely in the HttpOnly cookie the API sets at sign-in, which
 * page scripts cannot read and therefore cannot leak into `localStorage`.
 *
 * That is a stronger guarantee than a rule against writing to storage: there is
 * simply no value here to write. `platform-storage.test.ts` asserts it stays
 * that way.
 *
 * `credentials: "include"` sends the cookie. `X-Blueline-Session` is the
 * custom header the API demands on every cookie-authenticated state-changing
 * request — a cross-site HTML form cannot set a custom header, and a
 * cross-origin fetch that tries triggers a preflight the API will not answer
 * for a foreign origin. Together they are the CSRF control, unchanged from the
 * Company portal's.
 */
export class PlatformApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

interface ErrorPayload {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const defaultTimeoutMs = 15_000;

async function request<TResponse>(
  path: string,
  init: { body?: unknown; headers?: Readonly<Record<string, string>>; method: string; timeoutMs?: number },
): Promise<TResponse | undefined> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), init.timeoutMs ?? defaultTimeoutMs);
  try {
    const response = await fetch(`${platformConfiguration.apiBaseUrl}/${path.replace(/^\//, "")}`, {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Blueline-Session": "cookie",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      method: init.method,
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = (response.headers.get("content-type") ?? "").includes("application/json")
        ? ((await response.json()) as ErrorPayload)
        : undefined;
      throw new PlatformApiError(
        payload?.error?.message ?? "The request could not be completed",
        payload?.error?.code ?? "request_failed",
        response.status,
      );
    }
    if (response.status === 204) return undefined;
    return (await response.json()) as TResponse;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export interface PlatformIdentity {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly kind: "platform_administrator";
  readonly companyId: null;
  readonly permissions: readonly string[];
  readonly roles: readonly string[];
}

export type CompanyStatus = "draft" | "active" | "suspended" | "disabled" | "closed";
export type CompanyEnvironment = "development" | "demo" | "sandbox" | "trial" | "production";

export interface PlatformCompanySummary {
  readonly id: string;
  readonly code: string;
  readonly subdomain: string;
  readonly nameEn: string;
  readonly status: CompanyStatus;
  readonly environment: CompanyEnvironment;
  readonly countryCode: string;
  readonly timezone: string | null;
  readonly baseCurrency: string | null;
  readonly defaultLanguage: string | null;
  readonly accountingSetupStatus: string;
  readonly companyAdminCount: number;
  readonly readinessState: string;
  readonly createdAt: string;
}

export interface CompanyPage {
  readonly items: readonly PlatformCompanySummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface CompanyListFilters {
  readonly search?: string;
  readonly status?: string;
  readonly environment?: string;
  readonly page?: number;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
}

export interface CompanyDetail {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly subdomain: string;
  readonly status: CompanyStatus;
  readonly environment: CompanyEnvironment;
  readonly countryCode: string;
  readonly contactName: string | null;
  readonly telephone: string | null;
  readonly email: string | null;
  readonly addressEn: string | null;
  readonly tradeLicenseNumber: string | null;
  readonly taxRegistrationNumber: string | null;
  readonly nameAr: string | null;
  readonly timezone: string | null;
  readonly baseCurrency: string | null;
  readonly defaultLanguage: string | null;
  readonly accountingSetupStatus: string;
  readonly accountingTemplateCode: string | null;
  readonly accountingTemplateVersion: number | null;
  readonly accountingTemplateSha256: string | null;
  readonly accountingSetupAppliedAt: string | null;
  readonly accountingSetupAppliedBy: string | null;
  readonly createdAt: string;
  readonly statusChangeReason: string | null;
  readonly closedAt: string | null;
}

export interface CompanyDeletionEligibility {
  readonly eligible: boolean;
  readonly status: string;
  readonly environment: string;
  readonly closedAt: string | null;
  readonly eligibleAt: string | null;
  readonly requiresWaitingPeriod: boolean;
  readonly waitingPeriodHours: number;
  readonly remainingSeconds: number;
  readonly blockers: readonly string[];
  readonly previewRequired: true;
  readonly backupRequired: true;
}

export interface CompanyDeletionPreview {
  readonly previewId: string;
  readonly operationId: string;
  readonly manifestVersion: string;
  readonly manifestHash: string;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly moduleCounts: Readonly<Record<string, number>>;
  readonly totalCompanyRows: number;
  readonly blockers: readonly string[];
  readonly guardedTriggers: readonly { readonly tableName: string; readonly triggerName: string }[];
  readonly globalPreserved: readonly string[];
  readonly externalFiles: { readonly fileObjects: number; readonly strategy: string };
  readonly readyForDelete: boolean;
}

export interface CompanyDeletionBackup {
  readonly id: string;
  readonly backupType: "full_database";
  readonly status: "verified";
  readonly backupReference: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly verifiedAt: string;
}

export interface AccountingSetupSummary {
  readonly status: string;
  readonly templateCode: string | null;
  readonly templateVersion: number | null;
  readonly templateSha256: string | null;
  readonly appliedAt: string | null;
  readonly appliedBy: string | null;
  readonly businessDay: { readonly timezone: string; readonly startTime: string } | null;
  readonly counts: Readonly<Record<string, number>>;
}

export interface ReadinessItem {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly state: "complete" | "incomplete" | "optional";
  readonly note: string | null;
}

export interface ReadinessSummary {
  readonly status: CompanyStatus;
  readonly items: readonly ReadinessItem[];
  /** Operational notes that do NOT block activation, such as no open period. */
  readonly warnings?: readonly string[];
  readonly canActivate: boolean;
  readonly blockedBy: readonly string[];
  readonly nextStep: string;
}

export interface ApprovedTemplateOption {
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly displayName: string;
}

export interface AuditEntry {
  readonly action: string;
  readonly reason: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly source: string;
  readonly actor: string | null;
}

/** One entry in the Platform-wide trail, which spans every Company. */
export interface PlatformAuditEntry extends AuditEntry {
  readonly id: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly actorUsername: string | null;
  readonly subjectType: string;
  readonly subjectId: string | null;
}

export interface PlatformAuditPage {
  readonly items: readonly PlatformAuditEntry[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface PlatformAuditFilters {
  readonly companyId?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export type CompanyUserState = "active" | "invitation_pending" | "locked" | "disabled";

export interface CompanyUser {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly username: string;
  readonly email: string | null;
  readonly mobileNumber: string | null;
  readonly status: string;
  readonly state: CompanyUserState;
  readonly roles: readonly string[];
  readonly lockedUntil: string | null;
  readonly failedLoginAttempts: number;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly activeSetupLinkExpiresAt: string | null;
}

export interface CompanySession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly userAgent: string | null;
  readonly createdIp: string | null;
}

export interface UserDeletionEligibility {
  readonly eligible: boolean;
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly companyId: string;
  readonly companyName: string;
  readonly activeSessions: number;
  readonly isLastAdministrator: boolean;
  readonly blockingRows: number;
  readonly blockingCategories: readonly { readonly category: string; readonly rows: number }[];
  readonly recommendedAction: "delete" | "deactivate";
  readonly reason: string | null;
  readonly confirmationChallenge: string;
}

/**
 * A one-time credential link.
 *
 * Held in component state for exactly as long as the panel showing it is open.
 * It is never written to any browser store: a link that survived a refresh
 * would outlive the moment it was meant for.
 */
export interface SetupLink {
  readonly setupUrl: string;
  readonly expiresAt: string;
}

export interface CreateAdministratorPayload {
  readonly displayName: string;
  readonly username: string;
  readonly email: string;
  readonly mobileNumber: string;
  readonly preferredLanguage: string;
}

export interface CreateCompanyPayload {
  readonly name: string;
  readonly subdomain?: string;
  readonly environment: string;
  readonly countryCode?: string;
  readonly timezone?: string;
  readonly defaultLanguage?: string;
  readonly contactName?: string;
  readonly telephone?: string;
  readonly email?: string;
  readonly businessDayStart?: string;
  readonly accountingTemplateCode?: string;
  readonly accountingTemplateVersion?: number;
}

export const platformApi = {
  async login(identifier: string, password: string): Promise<PlatformIdentity> {
    const result = await request<{ identity: PlatformIdentity }>("platform/auth/login", {
      body: { identifier, password },
      method: "POST",
    });
    if (result === undefined) throw new PlatformApiError("Empty sign-in response", "empty", 500);
    return result.identity;
  },

  async me(): Promise<PlatformIdentity> {
    const result = await request<PlatformIdentity>("platform/auth/me", { method: "GET" });
    if (result === undefined) throw new PlatformApiError("Empty session response", "empty", 500);
    return result;
  },

  async logout(): Promise<void> {
    await request("platform/auth/logout", { method: "POST" });
  },

  async companies(filters: CompanyListFilters = {}): Promise<CompanyPage> {
    const query = new URLSearchParams();
    if (filters.search !== undefined && filters.search !== "") query.set("search", filters.search);
    if (filters.status !== undefined && filters.status !== "") query.set("status", filters.status);
    if (filters.environment !== undefined && filters.environment !== "") {
      query.set("environment", filters.environment);
    }
    if (filters.sort !== undefined) query.set("sort", filters.sort);
    if (filters.direction !== undefined) query.set("direction", filters.direction);
    query.set("page", String(filters.page ?? 1));
    const result = await request<CompanyPage>(`platform/companies?${query.toString()}`, {
      method: "GET",
    });
    return result ?? { items: [], total: 0, page: 1, pageSize: 25 };
  },

  async approvedTemplates(): Promise<readonly ApprovedTemplateOption[]> {
    const result = await request<{ items: ApprovedTemplateOption[] }>(
      "platform/companies/accounting-templates",
      { method: "GET" },
    );
    return result?.items ?? [];
  },

  async createCompany(payload: CreateCompanyPayload): Promise<{ companyId: string }> {
    const result = await request<{ companyId: string }>("platform/companies", {
      body: payload,
      method: "POST",
    });
    if (result === undefined) throw new PlatformApiError("Empty create response", "empty", 500);
    return result;
  },

  async company(companyId: string): Promise<CompanyDetail> {
    const result = await request<CompanyDetail>(`platform/companies/${companyId}`, {
      method: "GET",
    });
    if (result === undefined) throw new PlatformApiError("Empty Company response", "empty", 500);
    return result;
  },

  async accountingSetup(companyId: string): Promise<AccountingSetupSummary> {
    const result = await request<AccountingSetupSummary>(
      `platform/companies/${companyId}/accounting-setup`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty setup response", "empty", 500);
    return result;
  },

  async readiness(companyId: string): Promise<ReadinessSummary> {
    const result = await request<ReadinessSummary>(`platform/companies/${companyId}/readiness`, {
      method: "GET",
    });
    if (result === undefined) throw new PlatformApiError("Empty readiness response", "empty", 500);
    return result;
  },

  async lifecycle(companyId: string, action: string, reason?: string): Promise<void> {
    await request(`platform/companies/${companyId}/${action}`, {
      body: reason === undefined ? {} : { reason },
      method: "POST",
    });
  },

  async closeCompany(companyId: string, reason: string, confirmation: string): Promise<void> {
    await request(`platform/companies/${companyId}/close`, {
      body: { reason, confirmation },
      method: "POST",
    });
  },

  async companyDeletionEligibility(companyId: string): Promise<CompanyDeletionEligibility> {
    const result = await request<CompanyDeletionEligibility>(
      `platform/companies/${companyId}/deletion-eligibility`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty eligibility response", "empty", 500);
    return result;
  },

  async companyDeletionPreview(companyId: string, idempotencyKey: string): Promise<CompanyDeletionPreview> {
    const result = await request<CompanyDeletionPreview>(
      `platform/companies/${companyId}/deletion-preview`,
      {
        headers: { "Idempotency-Key": idempotencyKey },
        method: "POST",
      },
    );
    if (result === undefined) throw new PlatformApiError("Empty preview response", "empty", 500);
    return result;
  },

  async companyDeletionBackup(companyId: string, operationId: string): Promise<CompanyDeletionBackup> {
    const result = await request<CompanyDeletionBackup>(
      `platform/companies/${companyId}/deletion-backup`,
      { body: { operationId }, method: "POST", timeoutMs: 310_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty backup response", "empty", 500);
    return result;
  },

  async permanentlyDeleteCompany(
    companyId: string,
    input: { operationId: string; previewId: string; confirmation: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    const result = await request<Record<string, unknown>>(
      `platform/companies/${companyId}/permanent-delete`,
      { body: input, method: "POST", timeoutMs: 120_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty deletion response", "empty", 500);
    return result;
  },

  async updateCompany(companyId: string, changes: Record<string, string>): Promise<void> {
    await request(`platform/companies/${companyId}`, { body: changes, method: "PATCH" });
  },

  async companyUsers(companyId: string): Promise<readonly CompanyUser[]> {
    const result = await request<{ items: CompanyUser[] }>(
      `platform/companies/${companyId}/users`,
      { method: "GET" },
    );
    return result?.items ?? [];
  },

  async createAdministrator(
    companyId: string,
    payload: CreateAdministratorPayload,
  ): Promise<SetupLink & { accountId: string }> {
    const result = await request<SetupLink & { accountId: string }>(
      `platform/companies/${companyId}/users/administrators`,
      { body: payload, method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty", 500);
    return result;
  },

  async issueSetupLink(
    companyId: string,
    accountId: string,
    kind: "activation" | "password-reset",
  ): Promise<SetupLink> {
    const result = await request<SetupLink>(
      `platform/companies/${companyId}/users/${accountId}/${kind}`,
      { method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty", 500);
    return result;
  },

  async userAction(
    companyId: string,
    accountId: string,
    action: "unlock" | "deactivate" | "reactivate",
    reason?: string,
  ): Promise<void> {
    await request(`platform/companies/${companyId}/users/${accountId}/${action}`, {
      body: reason === undefined ? {} : { reason },
      method: "POST",
    });
  },

  async userSessions(companyId: string, accountId: string): Promise<readonly CompanySession[]> {
    const result = await request<{ items: CompanySession[] }>(
      `platform/companies/${companyId}/users/${accountId}/sessions`,
      { method: "GET" },
    );
    return result?.items ?? [];
  },

  async revokeSession(companyId: string, accountId: string, sessionId: string): Promise<void> {
    await request(
      `platform/companies/${companyId}/users/${accountId}/sessions/${sessionId}/revoke`,
      { method: "POST" },
    );
  },

  async revokeAllSessions(companyId: string, accountId: string): Promise<{ revoked: number }> {
    const result = await request<{ revoked: number }>(
      `platform/companies/${companyId}/users/${accountId}/sessions/revoke-all`,
      { method: "POST" },
    );
    return result ?? { revoked: 0 };
  },

  async userDeletionEligibility(
    companyId: string,
    accountId: string,
  ): Promise<UserDeletionEligibility> {
    const result = await request<UserDeletionEligibility>(
      `platform/companies/${companyId}/users/${accountId}/deletion-eligibility`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty eligibility response", "empty", 500);
    return result;
  },

  async deleteUser(companyId: string, accountId: string, confirmation: string): Promise<void> {
    await request(`platform/companies/${companyId}/users/${accountId}/delete`, {
      body: { confirmation },
      method: "POST",
    });
  },

  async audit(companyId: string): Promise<readonly AuditEntry[]> {
    const result = await request<{ items: AuditEntry[] }>(`platform/companies/${companyId}/audit`, {
      method: "GET",
    });
    return result?.items ?? [];
  },

  /**
   * The Platform-wide trail.
   *
   * Filters and paging are passed to the server rather than applied here: the
   * table is append-only and unbounded, so a client-side filter would either
   * describe one page as if it were everything, or require downloading a table
   * that only grows.
   */
  async platformAudit(filters: PlatformAuditFilters): Promise<PlatformAuditPage> {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === "") continue;
      parameters.set(key, String(value));
    }
    const result = await request<PlatformAuditPage>(`platform/audit?${parameters.toString()}`, {
      method: "GET",
    });
    return result ?? { items: [], total: 0, page: 1, pageSize: 25 };
  },

  async platformAuditActions(): Promise<readonly string[]> {
    const result = await request<{ items: string[] }>("platform/audit/actions", { method: "GET" });
    return result?.items ?? [];
  },
};
