import { platformConfiguration } from "../config/environment.js";

// Baked in by vite.config.ts's `define` -- see VersionBadge for the same
// contract.
declare const __APP_VERSION__: string;

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
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

interface ErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly correlationId?: string;
  };
}

const defaultTimeoutMs = 15_000;

async function request<TResponse>(
  path: string,
  init: {
    body?: unknown;
    headers?: Readonly<Record<string, string>>;
    method: string;
    timeoutMs?: number;
  },
): Promise<TResponse | undefined> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? defaultTimeoutMs,
  );
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
      const correlationId = payload?.error?.correlationId;
      // The API deliberately sanitizes 500s to a generic sentence — the real
      // message is captured server-side into the Error Handler. Showing that
      // generic sentence alone strands the reader; what they need is where
      // the details went and the reference to find them by.
      const message =
        response.status >= 500
          ? "The server hit an unexpected error. The full details were recorded in the " +
            `Error Handler screen${correlationId === undefined ? "" : ` under reference ${correlationId}`}.`
          : (payload?.error?.message ?? "The request could not be completed");
      throw new PlatformApiError(
        message,
        payload?.error?.code ?? "request_failed",
        response.status,
        correlationId,
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
  readonly pageSize?: number;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
}

export interface ErrorReport {
  readonly id: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly sourceApp: string;
  readonly severity: "high" | "medium" | "low";
  readonly status: "open" | "resolved";
  readonly message: string;
  readonly stack: string | null;
  readonly correlationId: string | null;
  readonly path: string | null;
  readonly accountId: string | null;
  readonly accountKind: string | null;
  readonly appCommit: string | null;
  readonly explanation: string | null;
  readonly resolutionNotes: string | null;
  readonly resolvedByAccountId: string | null;
  readonly resolvedByUsername: string | null;
  readonly resolvedAt: string | null;
  readonly occurredAt: string;
}

export interface ErrorReportPage {
  readonly items: readonly ErrorReport[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface ErrorReportListFilters {
  readonly companyId?: string;
  readonly sourceApp?: string;
  readonly severity?: string;
  readonly status?: string;
  readonly search?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export type DemoRequestStatus =
  | "new"
  | "reviewing"
  | "contacted"
  | "qualified"
  | "demo_scheduled"
  | "converted"
  | "not_interested"
  | "rejected"
  | "closed";
export type TraderApplicationStatus =
  | "pending_verification"
  | "reviewing"
  | "contacted"
  | "information_required"
  | "verified"
  | "approved"
  | "rejected"
  | "withdrawn";
export interface TraderApplication extends Record<string, unknown> {
  id: string;
  referenceNumber: string;
  storeName: string;
  contactPerson: string;
  mobileNumber: string;
  email: string;
  primaryCategory: string;
  pickupEmirate: string;
  monthlyOrderRange: string;
  hasExistingDeliveryCompany: boolean;
  requiresDeliveryCompany: boolean;
  status: TraderApplicationStatus;
  createdAt: string;
  assignedToUsername?: string;
}
export interface TraderApplicationPage {
  items: TraderApplication[];
  total: number;
  page: number;
  pageSize: number;
}
export interface TraderApplicationDetail extends TraderApplication {
  channels: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  internalNotes: Array<Record<string, unknown>>;
  deliveryEmirates: string[];
}
export interface DemoRequestSummary {
  readonly id: string;
  readonly referenceNumber: string;
  readonly companyName: string;
  readonly contactPerson: string;
  readonly mobileNumber: string;
  readonly email: string;
  readonly country: string;
  readonly emirate: string | null;
  readonly approximateDriverCount: number | null;
  readonly approximateMonthlyOrders: number | null;
  readonly approximateTraderCount: number | null;
  readonly preferredContactMethod: string;
  readonly source: string;
  readonly status: DemoRequestStatus;
  readonly assignedToUsername: string | null;
  readonly agentConversationReference?: string | null;
  readonly createdAt: string;
}
export interface DemoRequestDetail extends DemoRequestSummary {
  readonly website: string | null;
  readonly currentSystem: string | null;
  readonly mainChallenges: string | null;
  readonly featuresOfInterest: readonly string[];
  readonly notes: string | null;
  readonly landingPage: string;
  readonly referrer: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmTerm: string | null;
  readonly utmContent: string | null;
  readonly gclid: string | null;
  readonly convertedCompanyId: string | null;
  readonly convertedCompanyName: string | null;
  readonly agentConversationId?: string | null;
  readonly history: readonly Record<string, unknown>[];
  readonly internalNotes: readonly {
    id: string;
    noteText: string;
    authorUsername: string | null;
    createdAt: string;
  }[];
}
export interface DemoRequestPage {
  readonly items: readonly DemoRequestSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export interface DemoRequestFilters {
  readonly search?: string;
  readonly status?: string;
  readonly country?: string;
  readonly emirate?: string;
  readonly preferredContactMethod?: string;
  readonly source?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: "newest" | "oldest";
}
export interface WebsiteCmsBundle {
  readonly overview: Record<string, unknown>;
  readonly pages: any[];
  readonly pricing: any[];
  readonly features: any[];
  readonly faqs: any[];
  readonly helpCategories: any[];
  readonly helpArticles: any[];
  readonly media: any[];
  readonly navigation: any[];
  readonly contact: any;
  readonly revisions: any[];
}

export interface UpdateErrorReportInput {
  readonly severity?: "high" | "medium" | "low";
  readonly status?: "open" | "resolved";
  readonly explanation?: string;
  readonly resolutionNotes?: string;
}

export interface IntegrityFinding {
  readonly checkId: string;
  readonly checkLabel: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly severity: "high" | "medium" | "low";
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectReference: string;
  readonly detail: string;
}

export interface CompanyDetail {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly subdomain: string;
  /** Six-digit code the mobile app signs in with. */
  readonly mobileCode: string;
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
  readonly version: number;
  readonly shipmentPrefix: string | null;
  readonly shipmentSerialEnabledAt: string | null;
}

export interface CompanyWebsite {
  readonly id?: string;
  readonly companyId?: string;
  readonly slug?: string;
  readonly status: "not_configured" | "draft" | "published" | "disabled";
  readonly enabled?: boolean;
  readonly published?: boolean;
  readonly templateKey?: CompanyWebsiteTemplateKey;
  readonly publishedTemplateKey?: CompanyWebsiteTemplateKey | null;
  readonly hasUnpublishedChanges?: boolean;
  readonly primaryLanguage?: "en" | "ar";
  readonly defaultLocale?: "en" | "ar";
  readonly websiteUrl?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly publishedAt?: string | null;
  readonly disabledAt?: string | null;
  readonly lastPublishedBy?: string | null;
  readonly lastUpdatedBy?: string | null;
  readonly version?: number;
  readonly settings?: CompanyWebsiteSettings;
  readonly publishedSettings?: CompanyWebsiteSettings | null;
}

export type CompanyWebsiteTemplateKey =
  | "corporate"
  | "modern"
  | "express"
  | "local"
  | "premium"
  | "skyline"
  | "minimal"
  | "bold"
  | "elegant"
  | "urban"
  | "swift"
  | "horizon"
  | "nexus"
  | "oasis"
  | "fleet"
  | "commerce"
  | "courier"
  | "executive"
  | "vibrant"
  | "classic";

export interface CompanyWebsiteSettings {
  branding: {
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    logoDataUrl?: string;
    bannerDataUrl?: string;
    bannerDataUrls?: string[];
    bannerDataUrlsAr?: string[];
    bannerTransition?: "fade" | "slide" | "zoom";
    bannerIntervalSeconds?: 4 | 6 | 8;
  };
  languages: { en: boolean; ar: boolean; defaultLocale: "en" | "ar" };
  presentation: Record<string, { en?: string; ar?: string } | string | undefined>;
  contact: {
    phone?: string;
    mobile?: string;
    email?: string;
    address?: { en?: string; ar?: string };
    city?: { en?: string; ar?: string };
    whatsappEnabled: boolean;
    whatsappNumber?: string;
    whatsappMessage?: { en?: string; ar?: string };
    showPhone: boolean;
    showEmail: boolean;
    showWhatsapp: boolean;
    showAddress: boolean;
    showWorkingHours: boolean;
    latitude?: number;
    longitude?: number;
    workingHours: Array<{ day: string; closed: boolean; opens?: string; closes?: string }>;
  };
  services: Array<{
    id: string;
    title: { en?: string; ar?: string };
    description?: { en?: string; ar?: string };
    icon?: string;
    enabled: boolean;
    order: number;
  }>;
  coverage: Array<{
    id: string;
    emirate: string;
    emirateAr?: string;
    area?: string;
    areaAr?: string;
    group?: string;
    enabled: boolean;
    order: number;
  }>;
  benefits: Array<{
    id: string;
    title: { en?: string; ar?: string };
    description?: { en?: string; ar?: string };
    icon?: string;
    enabled: boolean;
    order: number;
  }>;
  marketing: {
    steps: Array<{
      id: string;
      title: { en?: string; ar?: string };
      description?: { en?: string; ar?: string };
      enabled: boolean;
      order: number;
    }>;
    industries: Array<{
      id: string;
      title: { en?: string; ar?: string };
      description?: { en?: string; ar?: string };
      enabled: boolean;
      order: number;
    }>;
    statistics: Array<{
      id: string;
      title: { en?: string; ar?: string };
      description?: { en?: string; ar?: string };
      enabled: boolean;
      order: number;
    }>;
    testimonials: Array<{
      id: string;
      title: { en?: string; ar?: string };
      description?: { en?: string; ar?: string };
      enabled: boolean;
      order: number;
    }>;
  };
  socialLinks: Record<string, string | undefined>;
  functions?: { trackingEnabled: boolean; requestDeliveryEnabled: boolean };
  seo?: {
    title?: { en?: string; ar?: string };
    description?: { en?: string; ar?: string };
    socialImageUrl?: string;
    indexable: boolean;
  };
  sections: Array<{ key: string; enabled: boolean; order: number }>;
  knowledge: {
    description?: { en?: string; ar?: string };
    audiences: Array<"ecommerce" | "smes" | "individuals" | "corporate">;
    packageTypes: string[];
    maximumWeightKg?: number;
    sizeRestrictions?: { en?: string; ar?: string };
    fragilePolicy?: { en?: string; ar?: string };
    prohibitedItems?: { en?: string; ar?: string };
    specialHandling?: { en?: string; ar?: string };
    cod: { supported: boolean; limitations?: { en?: string; ar?: string } };
    pricing: {
      mode: "quote" | "request_confirmation" | "contact";
      guidance?: { en?: string; ar?: string };
    };
    faqs: Array<{
      id: string;
      question: { en?: string; ar?: string };
      answer: { en?: string; ar?: string };
      enabled: boolean;
      order: number;
      websiteVisible: boolean;
      agentAvailable: boolean;
    }>;
    instructions: Record<string, { en?: string; ar?: string } | undefined>;
    tawseelhubAttribution: boolean;
  };
  agent: {
    enabled: boolean;
    displayName?: string;
    welcomeMessage?: { en?: string; ar?: string };
    handoffMessage?: { en?: string; ar?: string };
    suggestedActions: Array<
      "track" | "request_delivery" | "services" | "coverage" | "contact" | "whatsapp"
    >;
    tone: "professional" | "friendly_professional" | "concise" | "warm";
    unknownBehavior: "whatsapp" | "contact" | "submit_request" | "safe_response";
    capabilities: {
      companyInformation: boolean;
      tracking: boolean;
      deliveryRequest: boolean;
      quoteGuidance: boolean;
      whatsappHandoff: boolean;
      contactHandoff: boolean;
      faqAnswers: boolean;
      socialLinks: boolean;
    };
  };
}

export interface CompanyWebsitePreview {
  readonly availability: "published";
  readonly preview: boolean;
  readonly slug: string;
  readonly templateKey: CompanyWebsiteTemplateKey;
  readonly defaultLocale: "en" | "ar";
  readonly settings: CompanyWebsiteSettings;
  readonly company: {
    readonly nameEn: string;
    readonly nameAr: string | null;
    readonly subtitleEn: string | null;
    readonly subtitleAr: string | null;
    readonly telephone: string | null;
    readonly email: string | null;
    readonly addressEn: string | null;
    readonly addressAr: string | null;
    readonly hasLogo: boolean;
  };
}
export interface CompanyWebsiteDomain {
  id: string;
  hostname: string;
  status: "pending_verification" | "verified" | "pending_ssl" | "active" | "failed" | "disabled";
  verificationStatus: "pending" | "verified" | "failed";
  sslStatus: "pending" | "active" | "failed";
  isPrimary: boolean;
  verificationMethod: string;
  verificationRecords: Array<{ type: string; name: string; value: string }>;
  provider: string;
  lastError: string | null;
  version: number;
}
export interface CompanyWebsiteDomains {
  fallbackHostname: string;
  websiteVersion: number;
  cnameTarget: string | null;
  domains: CompanyWebsiteDomain[];
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
  readonly unknownReferences: readonly string[];
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

export interface CompanyResetTableCount {
  readonly table: string;
  readonly rows: number;
}

export interface CompanyResetPreview {
  readonly company: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: string;
    readonly environment: string;
  };
  readonly eligible: boolean;
  readonly blockers: readonly string[];
  readonly confirmation: string;
  readonly tables: readonly CompanyResetTableCount[];
  readonly totalRows: number;
}

export interface CompanyResetResult {
  readonly company: { readonly id: string; readonly code: string; readonly name: string };
  readonly removed: readonly CompanyResetTableCount[];
  readonly totalRemoved: number;
  readonly preservedVerified: number;
  readonly backupFile: string;
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
  readonly shipmentPrefix: string;
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

// ---------------------------------------------------------------------------
// Platform Dashboard
// ---------------------------------------------------------------------------

export interface DashboardFilters {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly companyId?: string | undefined;
  readonly groupBy?: "daily" | "weekly" | "monthly" | undefined;
}

export interface DashboardChange {
  readonly percent: number | null;
  readonly label: string;
}

export interface DashboardSummary {
  readonly companies: {
    readonly total: number;
    readonly active: number;
    readonly activePercent: number;
    readonly suspended: number;
    readonly suspendedPercent: number;
    readonly closed: number;
    readonly closedPercent: number;
    readonly draft: number;
    readonly disabled: number;
    readonly newThisMonth: number;
  };
  readonly orders: {
    readonly total: number;
    readonly totalChange: DashboardChange;
    readonly delivered: number;
    readonly deliveryRate: number | null;
    readonly cod: number;
    readonly codChange: DashboardChange;
    readonly serviceFees: number;
    readonly serviceFeesChange: DashboardChange;
  };
  readonly traders: { readonly total: number; readonly active: number; readonly new: number };
  readonly customers: { readonly total: number; readonly new: number };
  readonly drivers: { readonly total: number; readonly new: number };
  readonly employees: { readonly total: number; readonly new: number };
  readonly filters: {
    readonly companyId: string | null;
    readonly from: string;
    readonly to: string;
  };
  readonly metadata: {
    readonly codBasis: string;
    readonly serviceFeeBasis: string;
    readonly customerCountingNote: string;
    readonly deliveryRateDefinition: string;
    readonly previousPeriod: { readonly from: string; readonly to: string };
    readonly timezone: string;
  };
}

export interface OrdersTrendPoint {
  readonly bucket: string;
  readonly created: number;
  readonly delivered: number;
  readonly cancelled: number;
  readonly returned: number;
}

export interface OrdersTrend {
  readonly series: readonly OrdersTrendPoint[];
  readonly filters: { readonly groupBy: "daily" | "weekly" | "monthly" };
}

export interface DistributionItem {
  readonly value?: string;
  readonly status?: string;
  readonly emirate?: string;
  readonly count: number;
  readonly percent: number;
}

export interface Distribution {
  readonly items: readonly DistributionItem[];
  readonly total: number;
}

export interface CompanyRankingItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly environment: string;
  readonly orders: number;
  readonly delivered: number;
  readonly cod: number;
  readonly serviceFees: number;
  readonly traders: number;
  readonly customers: number;
}

export interface CompanyOverviewRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly environment: string;
  readonly orders: number;
  readonly delivered: number;
  readonly cod: number;
  readonly traders: number;
  readonly customers: number;
  readonly drivers: number;
  readonly lastOrderAt: string | null;
}

export interface CompanyOverviewPage {
  readonly items: readonly CompanyOverviewRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface AttentionCategory {
  readonly key: string;
  readonly label: string;
  readonly severity: "critical" | "warning" | "info";
  readonly count: number;
  readonly companies: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  }[];
}

export interface NeedsAttention {
  readonly categories: readonly AttentionCategory[];
  readonly generatedAt: string;
}

function toQuery(filters: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(
    filters as Record<string, string | number | undefined>,
  )) {
    if (value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  return query.toString();
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
    if (filters.pageSize !== undefined) query.set("pageSize", String(filters.pageSize));
    query.set("page", String(filters.page ?? 1));
    const result = await request<CompanyPage>(`platform/companies?${query.toString()}`, {
      method: "GET",
    });
    return result ?? { items: [], total: 0, page: 1, pageSize: 25 };
  },

  /**
   * Where this app's own error boundary (`PlatformErrorBoundary`) reports a
   * crash. Deliberately swallows its own failure -- reporting a crash must
   * never itself throw and mask the crash the boundary is already handling.
   */
  async reportError(input: {
    readonly message: string;
    readonly stack?: string;
    readonly path?: string;
  }): Promise<void> {
    try {
      await request("errors", {
        body: {
          appCommit: __APP_VERSION__,
          message: input.message,
          path: input.path ?? window.location.pathname,
          sourceApp: "platform-web",
          stack: input.stack,
        },
        method: "POST",
      });
    } catch {
      // See doc comment above.
    }
  },

  async errors(filters: ErrorReportListFilters = {}): Promise<ErrorReportPage> {
    const query = new URLSearchParams();
    if (filters.companyId !== undefined && filters.companyId !== "") {
      query.set("companyId", filters.companyId);
    }
    if (filters.sourceApp !== undefined && filters.sourceApp !== "") {
      query.set("sourceApp", filters.sourceApp);
    }
    if (filters.severity !== undefined && filters.severity !== "") {
      query.set("severity", filters.severity);
    }
    if (filters.status !== undefined && filters.status !== "") query.set("status", filters.status);
    if (filters.search !== undefined && filters.search !== "") query.set("search", filters.search);
    if (filters.occurredFrom !== undefined && filters.occurredFrom !== "") {
      query.set("occurredFrom", filters.occurredFrom);
    }
    if (filters.occurredTo !== undefined && filters.occurredTo !== "") {
      query.set("occurredTo", filters.occurredTo);
    }
    if (filters.pageSize !== undefined) query.set("pageSize", String(filters.pageSize));
    query.set("page", String(filters.page ?? 1));
    const result = await request<ErrorReportPage>(`platform/errors?${query.toString()}`, {
      method: "GET",
    });
    return result ?? { items: [], page: 1, pageSize: 25, total: 0 };
  },

  async deleteErrors(ids: string[]): Promise<{ deletedCount: number }> {
    const result = await request<{ deletedCount: number }>("platform/errors", {
      body: { ids },
      method: "DELETE",
    });
    return result ?? { deletedCount: 0 };
  },

  async demoRequests(filters: DemoRequestFilters = {}): Promise<DemoRequestPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const result = await request<DemoRequestPage>(`platform/demo-requests?${query.toString()}`, {
      method: "GET",
    });
    return result ?? { items: [], total: 0, page: 1, pageSize: 25 };
  },
  async demoRequest(id: string): Promise<DemoRequestDetail> {
    const result = await request<DemoRequestDetail>(`platform/demo-requests/${id}`, {
      method: "GET",
    });
    if (result === undefined)
      throw new PlatformApiError("Empty demo request response", "empty", 500);
    return result;
  },
  async updateDemoRequestStatus(
    id: string,
    input: {
      status: DemoRequestStatus;
      reason?: string;
      demoScheduledAt?: string;
      convertedCompanyId?: string;
    },
  ): Promise<DemoRequestDetail> {
    const result = await request<DemoRequestDetail>(`platform/demo-requests/${id}/status`, {
      method: "PATCH",
      body: input,
    });
    if (result === undefined)
      throw new PlatformApiError("Empty demo request response", "empty", 500);
    return result;
  },
  async addDemoRequestNote(id: string, text: string): Promise<void> {
    await request(`platform/demo-requests/${id}/notes`, { method: "POST", body: { text } });
  },
  async deleteDemoRequests(ids: string[]): Promise<any> {
    return await request<any>("platform/demo-requests", { method: "DELETE", body: { ids } });
  },
  async websiteCms(): Promise<WebsiteCmsBundle> {
    const result = await request<WebsiteCmsBundle>("platform/website", { method: "GET" });
    return (
      result ?? {
        overview: {},
        pages: [],
        pricing: [],
        features: [],
        faqs: [],
        helpCategories: [],
        helpArticles: [],
        media: [],
        navigation: [],
        contact: null,
        revisions: [],
      }
    );
  },
  async saveWebsitePage(pageKey: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/pages/${pageKey}/${locale}/draft`, {
      method: "PATCH",
      body: input,
    });
  },
  async publishWebsitePage(pageKey: string, locale: string): Promise<any> {
    return await request<any>(`platform/website/pages/${pageKey}/${locale}/publish`, {
      method: "POST",
      body: {},
    });
  },
  async saveWebsitePricing(planKey: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/pricing/${planKey}/${locale}/draft`, {
      method: "PATCH",
      body: input,
    });
  },
  async publishWebsitePricing(planKey: string, locale: string): Promise<any> {
    return await request<any>(`platform/website/pricing/${planKey}/${locale}/publish`, {
      method: "POST",
      body: {},
    });
  },
  async saveWebsiteFeature(slug: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/features/${slug}/${locale}`, {
      method: "PATCH",
      body: input,
    });
  },
  async publishWebsiteFeature(slug: string, locale: string): Promise<any> {
    return await request<any>(`platform/website/features/${slug}/${locale}/publish`, {
      method: "POST",
      body: {},
    });
  },
  async saveWebsiteFaq(faqKey: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/faqs/${faqKey}/${locale}`, {
      method: "PATCH",
      body: input,
    });
  },
  async publishWebsiteFaq(faqKey: string, locale: string): Promise<any> {
    return await request<any>(`platform/website/faqs/${faqKey}/${locale}/publish`, {
      method: "POST",
      body: {},
    });
  },
  async saveHelpCategory(slug: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/help/categories/${slug}/${locale}`, {
      method: "PATCH",
      body: input,
    });
  },
  async saveHelpArticle(slug: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/help/articles/${slug}/${locale}`, {
      method: "PATCH",
      body: input,
    });
  },
  async publishHelpArticle(slug: string, locale: string): Promise<any> {
    return await request<any>(`platform/website/help/articles/${slug}/${locale}/publish`, {
      method: "POST",
      body: {},
    });
  },
  async archiveHelpArticle(slug: string, locale: string): Promise<any> {
    return await request<any>(`platform/website/help/articles/${slug}/${locale}/archive`, {
      method: "POST",
      body: {},
    });
  },
  async saveWebsiteContact(input: any): Promise<any> {
    return await request<any>("platform/website/contact/draft", { method: "PATCH", body: input });
  },
  async publishWebsiteContact(): Promise<any> {
    return await request<any>("platform/website/contact/publish", { method: "POST", body: {} });
  },
  async saveWebsiteNavigation(itemKey: string, locale: string, input: any): Promise<any> {
    return await request<any>(`platform/website/navigation/${itemKey}/${locale}`, {
      method: "PATCH",
      body: input,
    });
  },
  async uploadWebsiteMedia(file: File, input: { altText: string; caption?: string }): Promise<any> {
    const form = new FormData();
    form.append("file", file);
    form.append("altText", input.altText);
    if (input.caption) form.append("caption", input.caption);
    const response = await fetch(`${platformConfiguration.apiBaseUrl}/platform/website/media`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "X-Blueline-Session": "cookie" },
      body: form,
    });
    if (!response.ok) {
      throw new PlatformApiError(
        "Featured image must be JPG, PNG, or WebP.",
        "media_upload_failed",
        response.status,
      );
    }
    return await response.json();
  },

  async errorDetail(id: string): Promise<ErrorReport> {
    const result = await request<ErrorReport>(`platform/errors/${id}`, { method: "GET" });
    if (result === undefined) throw new PlatformApiError("Empty error report", "empty", 500);
    return result;
  },

  async updateError(id: string, input: UpdateErrorReportInput): Promise<ErrorReport> {
    const result = await request<ErrorReport>(`platform/errors/${id}`, {
      body: input,
      method: "PATCH",
    });
    if (result === undefined) throw new PlatformApiError("Empty error report", "empty", 500);
    return result;
  },

  async integrityFindings(companyId?: string): Promise<readonly IntegrityFinding[]> {
    const query = new URLSearchParams();
    if (companyId !== undefined && companyId !== "") query.set("companyId", companyId);
    const result = await request<readonly IntegrityFinding[]>(
      `platform/integrity?${query.toString()}`,
      { method: "GET" },
    );
    return result ?? [];
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

  async companyWebsite(companyId: string): Promise<CompanyWebsite> {
    const result = await request<CompanyWebsite>(`platform/companies/${companyId}/website`, {
      method: "GET",
    });
    return result ?? { status: "not_configured" };
  },

  async configureCompanyWebsite(
    companyId: string,
    payload: {
      slug: string;
      primaryLanguage: "en" | "ar";
      defaultLocale: "en" | "ar";
      templateKey: CompanyWebsiteTemplateKey;
      expectedVersion: number;
      settings?: CompanyWebsiteSettings;
    },
  ): Promise<CompanyWebsite> {
    const current = await this.companyWebsite(companyId);
    const result = await request<CompanyWebsite>(`platform/companies/${companyId}/website`, {
      body: payload,
      method: current.status === "not_configured" ? "POST" : "PATCH",
    });
    if (result === undefined) throw new PlatformApiError("Empty website response", "empty", 500);
    return result;
  },

  async companyWebsiteAction(
    companyId: string,
    action: "publish" | "disable" | "enable",
    expectedVersion: number,
  ): Promise<CompanyWebsite> {
    const result = await request<CompanyWebsite>(
      `platform/companies/${companyId}/website/${action}`,
      { body: { expectedVersion }, method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty website response", "empty", 500);
    return result;
  },

  async companyWebsitePreview(
    companyId: string,
    templateKey?: CompanyWebsiteTemplateKey,
  ): Promise<CompanyWebsitePreview> {
    const result = await request<CompanyWebsitePreview>(
      `platform/companies/${companyId}/website/preview${templateKey ? `?templateKey=${encodeURIComponent(templateKey)}` : ""}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty website preview", "empty", 500);
    return result;
  },

  async companyWebsiteDomains(companyId: string): Promise<CompanyWebsiteDomains> {
    const result = await request<CompanyWebsiteDomains>(
      `platform/companies/${companyId}/website/domains`,
      { method: "GET" },
    );
    if (!result) throw new PlatformApiError("Empty domains response", "empty", 500);
    return result;
  },
  async addCompanyWebsiteDomain(
    companyId: string,
    hostname: string,
  ): Promise<CompanyWebsiteDomain> {
    const result = await request<CompanyWebsiteDomain>(
      `platform/companies/${companyId}/website/domains`,
      { method: "POST", body: { hostname } },
    );
    if (!result) throw new PlatformApiError("Empty domain response", "empty", 500);
    return result;
  },
  async companyWebsiteDomainAction(
    companyId: string,
    domainId: string,
    action: "refresh" | "disable" | "remove",
    expectedVersion: number,
  ): Promise<CompanyWebsiteDomain | CompanyWebsiteDomains> {
    const result = await request<CompanyWebsiteDomain | CompanyWebsiteDomains>(
      `platform/companies/${companyId}/website/domains/${domainId}/${action}`,
      { method: "POST", body: { expectedVersion } },
    );
    if (!result) throw new PlatformApiError("Empty domain response", "empty", 500);
    return result;
  },
  async makeCompanyWebsiteDomainPrimary(
    companyId: string,
    domainId: string,
    expectedVersion: number,
    expectedWebsiteVersion: number,
  ): Promise<CompanyWebsiteDomains> {
    const result = await request<CompanyWebsiteDomains>(
      `platform/companies/${companyId}/website/domains/${domainId}/make-primary`,
      { method: "POST", body: { expectedVersion, expectedWebsiteVersion } },
    );
    if (!result) throw new PlatformApiError("Empty domain response", "empty", 500);
    return result;
  },

  async companyWebsiteAgentPreview(
    companyId: string,
    message: string,
    language: "en" | "ar",
  ): Promise<{
    preview: true;
    noindex: true;
    reply: string;
    assistantName: string;
    language: "en" | "ar";
  }> {
    const result = await request<{
      preview: true;
      noindex: true;
      reply: string;
      assistantName: string;
      language: "en" | "ar";
    }>(`platform/companies/${companyId}/website/preview-agent`, {
      body: { message, language },
      method: "POST",
    });
    if (!result) throw new PlatformApiError("Empty agent preview", "empty", 500);
    return result;
  },

  async companyWebsiteTrackingPreview(companyId: string, trackingToken: string): Promise<unknown> {
    return await request<unknown>(`platform/companies/${companyId}/website/preview-track`, {
      body: { trackingToken },
      method: "POST",
    });
  },

  async discardCompanyWebsiteDraft(
    companyId: string,
    expectedVersion: number,
  ): Promise<CompanyWebsite> {
    const result = await request<CompanyWebsite>(
      `platform/companies/${companyId}/website/discard-draft`,
      { body: { expectedVersion }, method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty website response", "empty", 500);
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

  async updateShipmentPrefix(
    companyId: string,
    shipmentPrefix: string,
    expectedVersion: number,
  ): Promise<void> {
    await request(`platform/companies/${companyId}/shipment-prefix`, {
      body: { shipmentPrefix, expectedVersion },
      method: "PATCH",
    });
  },

  async activateShipmentSerial(
    companyId: string,
    reason: string,
    expectedVersion: number,
  ): Promise<void> {
    await request(`platform/companies/${companyId}/shipment-serial/activate`, {
      body: { reason, expectedVersion },
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
    if (result === undefined)
      throw new PlatformApiError("Empty eligibility response", "empty", 500);
    return result;
  },

  async companyDeletionPreview(
    companyId: string,
    idempotencyKey: string,
  ): Promise<CompanyDeletionPreview> {
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

  async companyDeletionBackup(
    companyId: string,
    operationId: string,
  ): Promise<CompanyDeletionBackup> {
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

  async companyResetPreview(companyId: string): Promise<CompanyResetPreview> {
    const result = await request<CompanyResetPreview>(
      `platform/companies/${companyId}/reset-preview`,
      { method: "GET" },
    );
    if (result === undefined)
      throw new PlatformApiError("Empty reset preview response", "empty", 500);
    return result;
  },

  async resetCompanyData(companyId: string, confirmation: string): Promise<CompanyResetResult> {
    const result = await request<CompanyResetResult>(
      `platform/companies/${companyId}/reset-execute`,
      { body: { confirmation }, method: "POST", timeoutMs: 310_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty reset response", "empty", 500);
    return result;
  },

  async moveCompanyToProduction(companyId: string, reason?: string): Promise<void> {
    await request(`platform/companies/${companyId}/move-to-production`, {
      body: reason === undefined ? {} : { reason },
      method: "POST",
    });
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
    if (result === undefined)
      throw new PlatformApiError("Empty eligibility response", "empty", 500);
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

  async dashboardSummary(filters: DashboardFilters): Promise<DashboardSummary> {
    const result = await request<DashboardSummary>(
      `platform/dashboard/summary?${toQuery(filters)}`,
      {
        method: "GET",
      },
    );
    if (result === undefined)
      throw new PlatformApiError("Empty Dashboard summary response", "empty", 500);
    return result;
  },

  async dashboardOrdersTrend(filters: DashboardFilters): Promise<OrdersTrend> {
    const result = await request<OrdersTrend>(
      `platform/dashboard/orders-trend?${toQuery(filters)}`,
      {
        method: "GET",
      },
    );
    return result ?? { filters: { groupBy: "daily" }, series: [] };
  },

  async dashboardOrderStatus(filters: DashboardFilters): Promise<Distribution> {
    const result = await request<Distribution>(
      `platform/dashboard/order-status?${toQuery(filters)}`,
      {
        method: "GET",
      },
    );
    return result ?? { items: [], total: 0 };
  },

  async dashboardCompanyRanking(
    filters: DashboardFilters & { metric?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: readonly CompanyRankingItem[] }> {
    const result = await request<{ items: CompanyRankingItem[] }>(
      `platform/dashboard/company-ranking?${toQuery(filters)}`,
      { method: "GET" },
    );
    return result ?? { items: [] };
  },

  async dashboardCompaniesByStatus(filters: DashboardFilters): Promise<Distribution> {
    const result = await request<Distribution>(
      `platform/dashboard/companies-by-status?${toQuery(filters)}`,
      { method: "GET" },
    );
    return result ?? { items: [], total: 0 };
  },

  async dashboardCompaniesByEnvironment(filters: DashboardFilters): Promise<Distribution> {
    const result = await request<Distribution>(
      `platform/dashboard/companies-by-environment?${toQuery(filters)}`,
      { method: "GET" },
    );
    return result ?? { items: [], total: 0 };
  },

  async dashboardOrdersByEmirate(filters: DashboardFilters): Promise<Distribution> {
    const result = await request<Distribution>(
      `platform/dashboard/orders-by-emirate?${toQuery(filters)}`,
      { method: "GET" },
    );
    return result ?? { items: [], total: 0 };
  },

  async dashboardCompanyOverview(
    filters: DashboardFilters & {
      search?: string | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
      sort?: string | undefined;
      direction?: "asc" | "desc" | undefined;
    },
  ): Promise<CompanyOverviewPage> {
    const result = await request<CompanyOverviewPage>(
      `platform/dashboard/company-overview?${toQuery(filters)}`,
      { method: "GET" },
    );
    return result ?? { items: [], page: 1, pageSize: 25, total: 0 };
  },

  async dashboardNeedsAttention(): Promise<NeedsAttention> {
    const result = await request<NeedsAttention>("platform/dashboard/needs-attention", {
      method: "GET",
    });
    return result ?? { categories: [], generatedAt: new Date(0).toISOString() };
  },
  async traderApplications(filters: Record<string, unknown>): Promise<TraderApplicationPage> {
    const result = await request<TraderApplicationPage>(
      `platform/trader-applications?${toQuery(filters)}`,
      { method: "GET" },
    );
    return result ?? { items: [], total: 0, page: 1, pageSize: 25 };
  },
  async customerQuotes(): Promise<any[]> {
    return (await request<any[]>("platform/customer-quotes", { method: "GET" })) ?? [];
  },
  async platformFeeReceivables(): Promise<any[]> {
    return (
      (await request<any[]>("platform/customer-quotes/platform-fees", { method: "GET" })) ?? []
    );
  },
  async recordPlatformFeePayment(receivableId: string, input: any): Promise<any> {
    return await request<any>(`platform/customer-quotes/platform-fees/${receivableId}/payments`, {
      method: "POST",
      body: input,
    });
  },
  async deleteCustomerQuotes(ids: string[]): Promise<any> {
    return await request<any>("platform/customer-quotes", { method: "DELETE", body: { ids } });
  },
  async blogArticles(): Promise<any[]> {
    return (await request<any[]>("platform/blog", { method: "GET" })) ?? [];
  },
  async blogArticle(id: string): Promise<any> {
    return await request<any>(`platform/blog/${id}`, { method: "GET" });
  },
  async blogArticlePreview(id: string): Promise<any> {
    return await request<any>(`platform/blog/${id}/preview`, { method: "GET" });
  },
  async blogReferences(): Promise<any> {
    return await request<any>("platform/blog/references", { method: "GET" });
  },
  async createBlogArticle(input: any): Promise<any> {
    return await request<any>("platform/blog", { method: "POST", body: input });
  },
  async updateBlogArticle(id: string, input: any): Promise<any> {
    return await request<any>(`platform/blog/${id}`, { method: "PATCH", body: input });
  },
  async updateBlogArticleStatus(id: string, input: any): Promise<any> {
    return await request<any>(`platform/blog/${id}/status`, { method: "PATCH", body: input });
  },
  async publicSiteSettings(): Promise<any> {
    return await request<any>("platform/blog/settings", { method: "GET" });
  },
  async updatePublicSiteSettings(input: any): Promise<any> {
    return await request<any>("platform/blog/settings", { method: "PATCH", body: input });
  },
  async agentConversations(filters?: Record<string, unknown>): Promise<any> {
    return (
      (await request<any>(`platform/agent/conversations${filters ? `?${toQuery(filters)}` : ""}`, {
        method: "GET",
      })) ?? { items: [], total: 0, page: 1, pageSize: 25, counters: {} }
    );
  },
  async agentConversation(id: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}`, { method: "GET" });
  },
  async updateAgentConversationReview(id: string, input: any): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/review`, {
      method: "PATCH",
      body: input,
    });
  },
  async replyAgentWhatsApp(id: string, message: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/whatsapp/reply`, {
      method: "POST",
      body: { message },
    });
  },
  async replyAgentWebsite(id: string, message: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/website/reply`, {
      method: "POST",
      body: { message },
    });
  },
  async setAgentConversationMode(id: string, mode: string, note?: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/mode`, {
      method: "PATCH",
      body: { mode, ...(note ? { note } : {}) },
    });
  },
  async hideAgentConversation(id: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/hide`, { method: "PATCH" });
  },
  async unhideAgentConversation(id: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/unhide`, { method: "PATCH" });
  },
  async deleteAgentConversation(id: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/delete`, { method: "PATCH" });
  },
  async addAgentConversationComment(id: string, comment: string): Promise<any> {
    return await request<any>(`platform/agent/conversations/${id}/comments`, {
      method: "POST",
      body: { comment },
    });
  },
  async agentAssignees(): Promise<any[]> {
    return (await request<any[]>("platform/agent/assignees", { method: "GET" })) ?? [];
  },
  async agentHandoffs(): Promise<any[]> {
    return (await request<any[]>("platform/agent/handoffs", { method: "GET" })) ?? [];
  },
  async updateAgentHandoffStatus(id: string, status: string, notes?: string): Promise<any> {
    return await request<any>(`platform/agent/handoffs/${id}/status`, {
      method: "PATCH",
      body: { status, ...(notes ? { notes } : {}) },
    });
  },
  async agentKnowledge(): Promise<any[]> {
    return (await request<any[]>("platform/agent/knowledge", { method: "GET" })) ?? [];
  },
  async createAgentKnowledge(input: any): Promise<any> {
    return await request<any>("platform/agent/knowledge", { method: "POST", body: input });
  },
  async updateAgentKnowledge(id: string, input: any): Promise<any> {
    return await request<any>(`platform/agent/knowledge/${id}`, { method: "PATCH", body: input });
  },
  async agentSettings(): Promise<any> {
    return await request<any>("platform/agent/settings", { method: "GET" });
  },
  async updateAgentSettings(input: any): Promise<any> {
    return await request<any>("platform/agent/settings", { method: "PATCH", body: input });
  },
  async commerceProviders(): Promise<any> {
    return (
      (await request<any>("platform/commerce-integrations/providers", { method: "GET" })) ?? {
        items: [],
      }
    );
  },
  async commerceMockTargets(): Promise<any> {
    return (
      (await request<any>("platform/commerce-integrations/mock-targets", { method: "GET" })) ?? {
        items: [],
      }
    );
  },
  async commerceConnections(filters?: Record<string, unknown>): Promise<any> {
    return (
      (await request<any>(
        `platform/commerce-integrations/connections${filters ? `?${toQuery(filters)}` : ""}`,
        { method: "GET" },
      )) ?? { items: [], total: 0, page: 1, pageSize: 25 }
    );
  },
  async commerceConnection(id: string): Promise<any> {
    return await request<any>(`platform/commerce-integrations/connections/${id}`, {
      method: "GET",
    });
  },
  async createMockCommerceConnection(input: any): Promise<any> {
    return await request<any>("platform/commerce-integrations/connections/mock", {
      method: "POST",
      body: input,
    });
  },
  async startSallaCommerceConnection(input: any): Promise<any> {
    return await request<any>("platform/commerce-integrations/connections/salla/start", {
      method: "POST",
      body: input,
    });
  },
  async startShopifyCommerceConnection(input: any): Promise<any> {
    return await request<any>("platform/commerce-integrations/connections/shopify/start", {
      method: "POST",
      body: input,
    });
  },
  async simulateCommerceEvent(id: string, input: any): Promise<any> {
    return await request<any>(`platform/commerce-integrations/connections/${id}/simulate`, {
      method: "POST",
      body: input,
    });
  },
  async testCommerceConnection(id: string, requestedState: string): Promise<any> {
    return await request<any>(`platform/commerce-integrations/connections/${id}/test`, {
      method: "POST",
      body: { requestedState },
    });
  },
  async disconnectCommerceConnection(id: string, reason: string): Promise<any> {
    return await request<any>(`platform/commerce-integrations/connections/${id}/disconnect`, {
      method: "POST",
      body: { reason },
    });
  },
  async reconnectCommerceConnection(id: string): Promise<any> {
    return await request<any>(`platform/commerce-integrations/connections/${id}/reconnect`, {
      method: "POST",
    });
  },
  async commerceAreas(id: string, search?: string): Promise<any> {
    return (
      (await request<any>(
        `platform/commerce-integrations/connections/${id}/areas${search ? `?${toQuery({ search })}` : ""}`,
        { method: "GET" },
      )) ?? { items: [] }
    );
  },
  async saveCommerceAreaMapping(id: string, input: any): Promise<any> {
    return await request<any>(`platform/commerce-integrations/connections/${id}/area-mappings`, {
      method: "POST",
      body: input,
    });
  },
  async retryCommerceEvent(id: string): Promise<any> {
    return await request<any>(`platform/commerce-integrations/events/${id}/retry`, {
      method: "POST",
    });
  },
  async outboundCommerceDelivered(orderId: string): Promise<any> {
    return await request<any>(
      `platform/commerce-integrations/orders/${orderId}/outbound-delivered`,
      { method: "POST" },
    );
  },
  async customerQuote(id: string): Promise<any> {
    return await request<any>(`platform/customer-quotes/${id}`, { method: "GET" });
  },
  async customerMarketplaceSettings(): Promise<any> {
    return await request<any>("platform/customer-quotes/settings/current", { method: "GET" });
  },
  async updateCustomerMarketplaceSettings(input: any): Promise<any> {
    return await request<any>("platform/customer-quotes/settings/current", {
      method: "PATCH",
      body: input,
    });
  },
  async createManualCustomerOffer(id: string, input: any): Promise<any> {
    return await request<any>(`platform/customer-quotes/${id}/offers`, {
      method: "POST",
      body: input,
    });
  },
  async convertCustomerQuoteToOrder(id: string, input: any): Promise<any> {
    return await request<any>(`platform/customer-quotes/${id}/convert-to-order`, {
      method: "POST",
      body: input,
    });
  },
  async traderApplication(id: string): Promise<TraderApplicationDetail> {
    const result = await request<TraderApplicationDetail>(`platform/trader-applications/${id}`, {
      method: "GET",
    });
    if (!result) throw new PlatformApiError("Empty Trader application response", "empty", 500);
    return result;
  },
  async updateTraderApplicationStatus(
    id: string,
    status: TraderApplicationStatus,
    reason?: string,
  ): Promise<TraderApplicationDetail> {
    const result = await request<TraderApplicationDetail>(
      `platform/trader-applications/${id}/status`,
      { method: "PATCH", body: { status, ...(reason ? { reason } : {}) } },
    );
    if (!result) throw new PlatformApiError("Empty Trader application response", "empty", 500);
    return result;
  },
  async addTraderApplicationNote(id: string, text: string): Promise<TraderApplicationDetail> {
    const result = await request<TraderApplicationDetail>(
      `platform/trader-applications/${id}/notes`,
      { method: "POST", body: { text } },
    );
    if (!result) throw new PlatformApiError("Empty Trader application response", "empty", 500);
    return result;
  },
  async resolveTraderApplicationCompany(
    id: string,
    resolution: string,
    companyId?: string,
  ): Promise<TraderApplicationDetail> {
    const result = await request<TraderApplicationDetail>(
      `platform/trader-applications/${id}/delivery-company-resolution`,
      { method: "PATCH", body: { resolution, ...(companyId ? { companyId } : {}) } },
    );
    if (!result) throw new PlatformApiError("Empty Trader application response", "empty", 500);
    return result;
  },
  async deleteTraderApplications(ids: string[]): Promise<any> {
    return await request<any>("platform/trader-applications", { method: "DELETE", body: { ids } });
  },
};
