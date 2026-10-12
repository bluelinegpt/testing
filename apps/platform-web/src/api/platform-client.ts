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
    readonly details?: readonly string[];
  };
}

export function platformApiErrorMessage(
  status: number,
  apiMessage: string | undefined,
  correlationId?: string,
): string {
  if (status === 429) return "Too many requests were sent. Please wait one minute, then try again.";
  if (status === 502)
    return (
      apiMessage ??
      "The Platform could not reach the service. Your changes were not saved. Please try again shortly."
    );
  if (status === 503)
    return (
      apiMessage ??
      "The service is temporarily unavailable, usually during a deployment or restart. Your changes were not saved. Please try again shortly."
    );
  if (status >= 500)
    return (
      "The server hit an unexpected error. The full details were recorded in the Error Handler screen" +
      (correlationId === undefined ? "." : ` under reference ${correlationId}.`)
    );
  return apiMessage ?? "The request could not be completed.";
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
      ...(init.body === undefined ? {} : { body: init.body instanceof FormData ? init.body : JSON.stringify(init.body) }),
      cache: "no-store",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Blueline-Session": "cookie",
        ...(init.body === undefined || init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
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
      const message = platformApiErrorMessage(
        response.status,
        response.status === 400 && Array.isArray(payload?.error?.details) && payload.error.details.length
          ? `${payload.error.message ?? "Validation failed"} ${payload.error.details.filter(x => typeof x === "string").slice(0, 8).join("; ")}`
          : payload?.error?.message,
        correlationId,
      );
      throw new PlatformApiError(
        message,
        payload?.error?.code ?? "request_failed",
        response.status,
        correlationId,
      );
    }
    if (response.status === 204) return undefined;
    return (await response.json()) as TResponse;
  } catch (failure) {
    if (failure instanceof PlatformApiError) throw failure;
    if (failure instanceof DOMException && failure.name === "AbortError")
      throw new PlatformApiError(
        "The request timed out before the service responded. Your changes were not saved. Please try again shortly.",
        "request_timeout",
        0,
      );
    throw new PlatformApiError(
      "The Platform could not connect to the service. Your changes were not saved. Check your connection and try again.",
      "network_unavailable",
      0,
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function uploadError(response: Response, fallback: string): Promise<PlatformApiError> {
  const payload = (response.headers.get("content-type") ?? "").includes("application/json")
    ? ((await response.json()) as ErrorPayload)
    : undefined;
  const correlationId = payload?.error?.correlationId;
  const apiMessage =
    response.status === 400 && Array.isArray(payload?.error?.details) && payload.error.details.length
      ? `${payload.error.message ?? "Validation failed"} ${payload.error.details.filter((x) => typeof x === "string").slice(0, 8).join("; ")}`
      : payload?.error?.message;
  return new PlatformApiError(
    platformApiErrorMessage(response.status, apiMessage ?? fallback, correlationId),
    payload?.error?.code ?? "media_upload_failed",
    response.status,
    correlationId,
  );
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
  readonly accepted?: boolean;
  readonly fingerprint?: string;
  readonly acceptanceId?: string;
}

export interface CompanyIntegrityCheck {
  readonly code: string;
  readonly severity: "critical" | "warning";
  readonly title: string;
  readonly count: number;
  readonly findings: readonly IntegrityFinding[];
}

export interface CompanyIntegrityReport {
  readonly companyId: string;
  readonly criticalCount: number;
  readonly warningCount: number;
  readonly previouslyReviewedCount: number;
  readonly checks: readonly CompanyIntegrityCheck[];
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
  /** True if this Website's saved logo/banner is still an old inline base64
   *  image (uploaded before Website media moved to R2) too large to send
   *  back here -- it's hidden from this response, not deleted. Uploading a
   *  new logo/banner replaces it; saving without uploading a replacement
   *  clears it. */
  readonly hasHiddenLegacyMedia?: boolean;
}

export interface CompanyWebsiteAiProposal {
  displayName: { en: string; ar: string };
  tagline: { en: string; ar: string };
  about: { en: string; ar: string };
  heroHeadline: { en: string; ar: string };
  heroSubheadline: { en: string; ar: string };
  primaryCtaLabel: { en: string; ar: string };
  services: Array<{ title: { en: string; ar: string }; description: { en: string; ar: string } }>;
  benefits: Array<{ title: { en: string; ar: string }; description: { en: string; ar: string } }>;
  faqs: Array<{ question: { en: string; ar: string }; answer: { en: string; ar: string } }>;
  seo: { title: { en: string; ar: string }; description: { en: string; ar: string } };
  agent: {
    displayName: string;
    welcomeMessage: { en: string; ar: string };
    handoffMessage: { en: string; ar: string };
  };
  colors: { primary: string; secondary: string; accent: string };
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
    bannerSize?: "compact" | "standard" | "full";
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
  readonly canonicalUrl?: string;
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
  readonly baseCurrency?: string;
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

/** Platform → Company → Route planning (free stored-pin Area engine). */
/** Mobile app access for one Company (all its mobile users). */
export interface CompanyMobileApp {
  readonly isEnabled: boolean;
  readonly changedAt: string | null;
  readonly activeMobileSessions: number;
}

/** Orders AI (the AI tab) for one Company. Version 0 = never saved (off). */
export interface CompanyOrdersAi {
  readonly isEnabled: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface CompanyRouteOptimization {
  companyId: string;
  isEnabled: boolean;
  platformEnabled: boolean;
  provider: string;
  dailyCallBudget: number;
  version: number;
  branchSet: boolean;
  areaCount: number;
  verifiedAreaCount: number;
  updatedAt: string | null;
  runsByDay: { businessDate: string; runs: number; fallbackRuns: number }[];
  usageByDay: {
    businessDate: string;
    callCount: number;
    successCount: number;
    failureCount: number;
    fallbackCount: number;
  }[];
}

export interface RouteKillSwitch {
  isEnabled: boolean;
  note: string | null;
  updatedAt: string;
}

export interface CompanyWhatsAppTemplate {
  status: string;
  bodyAr: string;
  bodyEn: string;
  /** Whether this status currently sends automatic notifications for the
   *  Company (the per-status allowlist; all statuses by default). */
  enabled: boolean;
  isCustom: boolean;
  updatedAt: string | null;
}

export interface CompanyWhatsAppOverview {
  enabled: boolean;
  disabledReason: string | null;
  connection: {
    status: string;
    connectedPhoneNumber: string | null;
    lastConnectedAt: string | null;
    lastDisconnectedAt: string | null;
  } | null;
  placeholders: readonly string[];
  templates: CompanyWhatsAppTemplate[];
}

export interface CompanyWhatsAppMessage {
  id: string;
  createdAt: string;
  messageType: string;
  status: string;
  failureCode: string | null;
  messageLanguage: string;
  groupNameSnapshot: string | null;
  traderName: string | null;
  orderNumber: string | null;
  messageBody: string;
}

export interface CompanyWhatsAppMessagesPage {
  items: CompanyWhatsAppMessage[];
  page: number;
  pageSize: number;
  totals: { total: number; pending: number; sent: number; failed: number };
}

export type AnnouncementType = "info" | "warning" | "critical";
export type AnnouncementSurface = "office_web" | "trader_portal" | "mobile_app";
export type AnnouncementAudience = "all_companies" | "selected_companies";
export type AnnouncementDisplayStatus = "scheduled" | "live" | "ended" | "cancelled";

/** A Platform announcement (maintenance / deployment banner) as the Platform sees it. */
export interface PlatformAnnouncement {
  readonly id: string;
  readonly type: AnnouncementType;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly bodyEn: string | null;
  readonly bodyAr: string | null;
  readonly showFrom: string;
  readonly showUntil: string;
  readonly surfaces: readonly AnnouncementSurface[];
  readonly audience: AnnouncementAudience;
  readonly companies: readonly { readonly id: string; readonly nameEn: string }[];
  readonly status: "active" | "cancelled";
  readonly displayStatus: AnnouncementDisplayStatus;
  readonly version: number;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveAnnouncementPayload {
  readonly type: AnnouncementType;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly bodyEn: string | null;
  readonly bodyAr: string | null;
  /** UTC ISO instants. */
  readonly showFrom: string;
  readonly showUntil: string;
  readonly surfaces: readonly AnnouncementSurface[];
  readonly audience: AnnouncementAudience;
  readonly companyIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Repair Center (read-only) -- Company Order Health
// ---------------------------------------------------------------------------

export type OrderHealth = "HEALTHY" | "ISSUE" | "REVIEW";
export type OrderHealthFilter = "attention" | "issue" | "review" | "healthy" | "all";
export type OrderHealthDateScope = "today" | "last7" | "last30" | "custom" | "all";

export interface OrderHealthScope {
  readonly scope: OrderHealthDateScope;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly today: string;
  readonly timezone: string;
  readonly dateBasis: "order_date";
}

export interface OrderHealthScopeQuery {
  readonly scope?: OrderHealthDateScope;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export interface OrderHealthListQuery extends OrderHealthScopeQuery {
  readonly health?: OrderHealthFilter;
  readonly search?: string;
  readonly deliveryStatus?: string;
  readonly reasonCode?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface CompanyOrderHealthSummary {
  readonly company: {
    readonly id: string;
    readonly code: string;
    readonly nameEn: string;
    readonly status: string;
    readonly environment: string | null;
  };
  readonly accountingMode: { readonly enabled: boolean };
  readonly generatedAt: string;
  readonly scope: OrderHealthScope;
  readonly companyHealth: OrderHealth;
  readonly totalOrders: number;
  readonly healthyOrders: number;
  readonly issueOrders: number;
  readonly reviewOrders: number;
  readonly byReason: readonly {
    readonly reasonCode: string;
    readonly health: OrderHealth;
    readonly reason: string;
    readonly orders: number;
  }[];
}

export interface OrderHealthRow {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderDate: string;
  readonly deliveryStatus: string;
  readonly health: OrderHealth;
  readonly classification: string;
  readonly reasonCode: string;
  readonly reason: string;
  readonly recommendedAction: string;
  readonly additionalReasonCodes: readonly string[];
}

export interface CompanyOrderHealthPage {
  readonly generatedAt: string;
  readonly scope: OrderHealthScope;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly OrderHealthRow[];
}

/** Verify First, as returned by the API (read-only drill-down). */
export interface OrderVerification {
  readonly classification: string;
  readonly health: OrderHealth;
  readonly reason: string;
  readonly order: Readonly<Record<string, string | null>>;
  readonly traderOwes: string;
  readonly physicalCollectionAmount: string;
  readonly settlementOffsetAmount: string;
  readonly historicalSettlementOffsetAmount: string;
  readonly settlementNumbers: readonly string[];
  readonly historicalSettlementNumbers: readonly string[];
  readonly receivables: readonly Readonly<Record<string, string | null>>[];
  readonly settlementOffsets: readonly {
    readonly settlementNumber: string;
    readonly receivableNumber: string;
    readonly receivableStatus: string;
    readonly amount: string;
    readonly effective: boolean;
  }[];
  readonly recommendedAction: string;
}

// Repair Center (read-only) -- Finding Details + Repair Plan Preview.
// Previews never execute anything. `execution.available` is true only for a
// READY finding of an executable certified capability (advisory: the server
// re-proves everything when Execute Repair is requested).
export type Repairability = "NOT_REQUIRED" | "READY" | "BLOCKED" | "MANUAL_REVIEW";

export interface RepairIssue {
  readonly code: string;
  readonly message: string;
}

export interface RepairFinding {
  readonly findingId: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly domain: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly entityNumber: string;
  readonly health: OrderHealth;
  readonly severity: "none" | "medium" | "high";
  readonly reasonCode: string;
  readonly title: string;
  readonly summary: string;
  readonly detectedState: string;
  readonly expectedState: string;
  readonly recommendedAction: string;
  readonly repairCapability: string | null;
  readonly repairability: Repairability;
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
  /** Phase 3 Prompt 3: present for a Trader-financial MANUAL_REVIEW finding. */
  readonly manualReview?: ManualReviewExplanation | null;
  readonly detectedAt: string;
}

/** Why a finding needs a person, with the financial comparison (Phase 3 Prompt 3). */
export interface ManualReviewExplanation {
  readonly headline: string;
  readonly reason: string;
  readonly whyAutomaticRepairIsUnavailable: readonly string[];
  readonly financialComparison: {
    readonly traderOwes: string;
    readonly currentReceivables: number;
    readonly historicalReceivables: number;
    readonly effectivePhysicalCollections: string;
    readonly effectiveSettlementOffsets: string;
    readonly receivables: readonly {
      readonly receivableNumber: string;
      readonly status: string;
      readonly current: boolean;
      readonly amountDue: string;
      readonly recordedCollected: string;
      readonly effectivePhysicalCollections: string;
      readonly effectiveSettlementOffsets: string;
      readonly effectiveSettled: string;
      readonly unexplainedDifference: string;
    }[];
  };
  readonly affectedRecords: {
    readonly collections: readonly {
      readonly collectionNumber: string;
      readonly receivableNumber: string;
      readonly collectionStatus: string;
      readonly current: boolean;
      readonly sameTraderAsReceivable: boolean;
      readonly allocatedToReceivable: string;
      readonly collectionAmountReceived: string;
      readonly collectionAllocatedTotal: string;
    }[];
    readonly settlements: readonly {
      readonly settlementNumber: string;
      readonly receivableNumber: string;
      readonly settlementStatus: string;
      readonly effective: boolean;
      readonly reversedBySettlementNumber: string | null;
      readonly sameTraderAsReceivable: boolean;
      readonly offsetAmount: string;
    }[];
    readonly credits: readonly {
      readonly creditNumber: string;
      readonly receivableNumber: string | null;
      readonly status: string;
      readonly amount: string;
    }[];
  };
}

export interface RepairDependencyNode {
  readonly entityType: string;
  readonly entityId: string;
  readonly entityNumber: string | null;
  readonly status: string;
  readonly amount: string | null;
  readonly relation: string;
}

export interface RepairDependencies {
  readonly current: readonly RepairDependencyNode[];
  readonly historical: readonly RepairDependencyNode[];
}

export interface OrderRepairFindings {
  readonly companyId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly deliveryStatus: string;
  readonly health: OrderHealth;
  readonly accountingMode: { readonly enabled: boolean };
  readonly findings: readonly RepairFinding[];
  readonly dependencies: RepairDependencies;
  readonly previewVersion: string;
  readonly generatedAt: string;
}

export interface RepairProposedChange {
  readonly entityType: string;
  readonly action: "create" | "update" | "delete" | "none";
  readonly entityNumber: string | null;
  readonly description: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RepairPreservedRecord {
  readonly entityType: string;
  readonly entityNumber: string | null;
  readonly description: string;
}

export interface RepairRequiredInput {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface RepairPlanPreview {
  readonly companyId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly finding: RepairFinding;
  readonly otherFindings: readonly RepairFinding[];
  readonly repairability: Repairability;
  readonly proposedRepair: {
    readonly capabilityCode: string;
    readonly title: string;
    readonly explanation: string;
    readonly executionHandler: string;
    readonly candidateOnly: boolean;
  } | null;
  readonly currentState: Readonly<Record<string, string | number | boolean | null>>;
  readonly proposedChanges: readonly RepairProposedChange[];
  readonly preservedHistory: readonly RepairPreservedRecord[];
  readonly dependencies: RepairDependencies;
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly requiredInputs: readonly RepairRequiredInput[];
  readonly requiredPermission: string | null;
  readonly idempotencyKeyBasis: string | null;
  readonly accountingMode: { readonly enabled: boolean };
  readonly previewVersion: string;
  readonly execution: {
    readonly available: boolean;
    readonly reason: string;
    readonly requiredPlatformPermission: string;
  };
  readonly generatedAt: string;
}

/** Execute Repair request: only WHICH finding/capability, never data. */
export interface RepairExecutionRequest {
  readonly findingId: string;
  readonly capabilityCode: string;
  readonly previewVersion: string;
  readonly reason: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export interface RepairExecutionResult {
  readonly repairExecutionId: string;
  readonly auditId: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly findingId: string;
  readonly reasonCode: string;
  readonly capabilityCode: string;
  readonly status: "succeeded";
  readonly beforeHealth: OrderHealth;
  readonly afterHealth: OrderHealth;
  readonly beforeClassification: string;
  readonly afterClassification: string;
  readonly beforePreviewVersion: string;
  readonly afterPreviewVersion: string;
  readonly executedAt: string;
  readonly replayed: boolean;
  readonly nextRecommendedAction: string;
}

// Repair Center -- Accounting Health + accounting recovery (Prompt 4).
export type AccountingTriage = "NOT_REQUIRED" | "READY_CANDIDATE" | "BLOCKED" | "MANUAL_REVIEW";
export type AccountingHealthStatusFilter =
  | "attention"
  | "failed"
  | "blocked_configuration"
  | "received"
  | "retry_pending"
  | "processing"
  | "posted"
  | "ignored_duplicate"
  | "ignored_no_accounting_required"
  | "reversed"
  | "all";

export interface AccountingHealthSummary {
  readonly companyId: string;
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly accountingHealth: "HEALTHY" | "ISSUE" | "REVIEW" | "NOT_APPLICABLE";
  readonly totalEvents: number;
  readonly failed: number;
  readonly blockedConfiguration: number;
  readonly pending: number;
  readonly processing: number;
  readonly stuck: number;
  readonly blocked: number;
  readonly readyCandidates: number;
  readonly manualReview: number;
  readonly historicalWhileOff: number;
  readonly byEventType: readonly { readonly eventType: string; readonly unresolved: number }[];
  readonly note: string;
  /** List/summary readiness is a CANDIDATE only; READY comes from Preview. */
  readonly readyCandidateNote?: string;
  /** Phase 4 Prompt 1: journal integrity of posted events (ISSUE, manual review). */
  readonly integrity?: {
    readonly postedWithoutJournal: number;
    readonly unbalancedJournals: number;
    readonly linkageMismatches: number;
    readonly duplicateEffectivePostings: number;
    readonly total: number;
  };
  /** Phase 4 Prompt 1: required events never captured (ISSUE, manual review). */
  readonly missingRequiredEvents?: {
    readonly total: number;
    readonly byEventType: readonly { readonly eventType: string; readonly missing: number }[];
  };
  /** The simple headline(s); details only after opening a finding. */
  readonly headlines?: readonly string[];
  readonly generatedAt: string;
}

export type AccountingIntegrityKind = "JOURNAL_INTEGRITY" | "MISSING_REQUIRED_EVENT";

/** One journal-integrity / missing-event finding: always MANUAL_REVIEW. */
export interface AccountingIntegrityRow {
  readonly kind: AccountingIntegrityKind;
  readonly code: string;
  readonly health: "ISSUE" | "REVIEW";
  readonly repairability: "MANUAL_REVIEW";
  readonly headline: string;
  readonly eventId: string | null;
  readonly eventType: string;
  readonly eventStatus: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly businessReference: string | null;
  readonly occurredOn: string | null;
  readonly journal: {
    readonly journalNumber: string | null;
    readonly status: string | null;
    readonly debit: string | null;
    readonly credit: string | null;
    readonly lines: number;
    readonly periodStatus: string | null;
  } | null;
  readonly actor: { readonly state: "VALID" | "MISSING" | "INVALID" };
  readonly reconstructable: boolean | null;
  readonly certifiedCapture: "COMPANY_HISTORICAL_RECOVERY" | null;
  readonly reason: string;
  readonly whyNotAutomatic: string;
  readonly recommendedInvestigation: string;
  readonly decision: string | null;
}

export interface AccountingIntegrityPage {
  readonly items: readonly AccountingIntegrityRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export interface AccountingIntegrityQuery {
  readonly kind?: AccountingIntegrityKind;
  readonly eventType?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** Phase 4 Prompt 1: the recovery context shown by details and Preview. */
export interface AccountingRecoveryContext {
  readonly decision: { readonly decision: string; readonly reason: string; readonly condition: string | null } | null;
  readonly source: { readonly type: string; readonly reference: string | null; readonly state: string };
  readonly originalActor: { readonly state: "VALID" | "MISSING" | "INVALID"; readonly accountKind: string | null; readonly accountStatus: string | null; readonly note: string };
  readonly fiscalPeriod: { readonly status: string | null; readonly yearStatus: string | null; readonly matches: number };
  readonly mappings: { readonly state: string; readonly blockerCodes: readonly string[] };
  readonly existingJournals: {
    readonly linkedToEvent: number;
    readonly postedForSource: number;
    readonly otherPostedEventsForSource: number;
    readonly eventJournal: { readonly journalNumber: string; readonly status: string; readonly balanced: boolean; readonly debit: string; readonly credit: string; readonly lines: number } | null;
  };
  readonly plannedOperation: string;
  readonly postRecoveryExpectation: string;
  readonly blocker: string | null;
  readonly recommendedInvestigation: readonly string[];
}

export interface AccountingHealthRow {
  readonly eventId: string;
  readonly businessReference: string | null;
  readonly sourceType: string;
  readonly eventType: string;
  readonly status: string;
  readonly triage: AccountingTriage;
  readonly triageCode: string;
  readonly finding: string;
  readonly lastFailure: string | null;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly accountingDate: string;
  readonly failedAt: string | null;
  /** True for READY CANDIDATES: run Preview Recovery for the authoritative state. */
  readonly previewRequired?: boolean;
}

export interface AccountingHealthPage {
  readonly items: readonly AccountingHealthRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export interface AccountingHealthQuery {
  readonly status?: AccountingHealthStatusFilter;
  readonly eventType?: string;
  readonly repairability?: AccountingTriage;
  readonly reference?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface AccountingFinding {
  readonly findingId: string;
  readonly eventId: string;
  readonly domain: "ACCOUNTING";
  readonly entityNumber: string;
  readonly health: OrderHealth;
  readonly classificationCode: string;
  readonly current: boolean;
  readonly title: string;
  readonly summary: string;
  readonly detectedState: string;
  readonly expectedState: string;
  readonly recommendedAction: string;
  readonly repairCapability: string | null;
  readonly repairability: Repairability;
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
}

export interface AccountingEventDetails {
  readonly companyId: string;
  readonly eventId: string;
  readonly event: {
    readonly eventType: string;
    readonly status: string;
    readonly sourceType: string;
    readonly businessReference: string | null;
    readonly accountingDate: string | null;
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly failureCategory: string | null;
    readonly failureCode: string | null;
    readonly failureSummary: string | null;
    readonly failedAt: string | null;
  };
  readonly support: { readonly support: string; readonly reason: string };
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly finding: AccountingFinding;
  readonly sourceOrderId: string | null;
  readonly diagnostics: {
    readonly fiscalPeriod: { readonly status: string | null; readonly yearStatus: string | null };
    readonly areaEnabled: boolean;
    readonly actorPresent: boolean;
    readonly postedJournalsForSource: number;
    readonly otherPostedEventsForSource: number;
    readonly precheck: {
      readonly accountingDate: string | null;
      readonly expectedDebitTotal: string;
      readonly expectedCreditTotal: string;
      readonly fiscalPeriodStatus: string | null;
      readonly resolvedMappings: readonly {
        readonly accountCode: string;
        readonly accountName: string;
        readonly amount: string;
        readonly entryIntent: string;
      }[];
    } | null;
  };
  /** Phase 4 Prompt 1 (absent from older servers). */
  readonly recovery?: AccountingRecoveryContext;
  readonly previewVersion: string;
  readonly generatedAt: string;
}

export interface AccountingRecoveryPreview {
  readonly companyId: string;
  readonly eventId: string;
  readonly businessReference: string | null;
  readonly finding: AccountingFinding;
  readonly repairability: Repairability;
  readonly proposedRepair: RepairPlanPreview["proposedRepair"];
  readonly currentState: Readonly<Record<string, string | number | boolean | null>>;
  readonly proposedChanges: readonly RepairProposedChange[];
  readonly preservedHistory: readonly RepairPreservedRecord[];
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly requiredInputs: readonly RepairRequiredInput[];
  readonly requiredPermission: string;
  readonly domainPermissionEquivalent: string;
  readonly idempotencyKeyBasis: string | null;
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly previewVersion: string;
  readonly execution: { readonly available: boolean; readonly reason: string; readonly requiredPlatformPermission: string };
  /** Phase 4 Prompt 1 (absent from older servers). */
  readonly recovery?: AccountingRecoveryContext;
  readonly generatedAt: string;
}

export interface AccountingRecoveryResult extends RepairExecutionResult {
  readonly eventId: string;
  readonly eventType: string;
  readonly journalNumber: string;
  readonly orderHealthAfter: string | null;
}

// ---------------------------------------------------------------------------
// Repair Center -- Payroll Health and Payroll period repair (Phase 5 Prompt 1).
// ---------------------------------------------------------------------------
export type PayrollHealthState = "HEALTHY" | "ISSUE" | "REVIEW";
export type PayrollRepairability = "READY" | "MANUAL_REVIEW" | "BLOCKED" | "NOT_REQUIRED";

export interface PayrollHealthSummary {
  readonly companyId: string;
  readonly payrollHealth: PayrollHealthState;
  readonly accountingMode: { readonly enabled: boolean };
  readonly totalPeriods: number;
  readonly periodsWithFindings: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly driverFeeFindings: number;
  readonly headlines: readonly string[];
  readonly generatedAt: string;
}

export interface PayrollHealthRow {
  readonly entityType: "payroll_period" | "outsourced_driver_fee_accrual";
  readonly entityId: string;
  readonly reference: string;
  readonly status: string | null;
  readonly health: "ISSUE" | "REVIEW";
  readonly codes: readonly string[];
  readonly headline: string;
}

export interface PayrollHealthPage {
  readonly items: readonly PayrollHealthRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export interface PayrollHealthQuery {
  readonly status?: "attention" | "all";
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PayrollRepairFinding {
  readonly findingId: string;
  readonly reasonCode: string;
  readonly health: "ISSUE" | "REVIEW";
  readonly headline: string;
  readonly reason: string;
  readonly repairability: PayrollRepairability;
  readonly repairCapability: string | null;
  readonly executionRoute: "payroll" | "accounting_event" | null;
  readonly blockers: readonly { readonly code: string; readonly message: string }[];
  readonly whyNotAutomatic: string | null;
  readonly recommendedAction: string;
  readonly execution: { readonly available: boolean; readonly requiredPlatformPermission: string };
  readonly plannedOperation: string;
  readonly expectedResult: string;
}

export interface PayrollLineState {
  readonly lineId: string;
  readonly payrollNumber: string;
  readonly employeeNumber: string | null;
  readonly employeeName: string | null;
  /** Today's workforce state; never a finding on its own (history is snapshotted). */
  readonly employeeActive?: boolean | null;
  /** Component snapshots and the records behind them (Phase 5 Prompt 2 detail view). */
  readonly components?: Readonly<Record<string, string>>;
  readonly status: string;
  readonly sourceMarker: string;
  readonly held: boolean;
  readonly current: { readonly gross: string; readonly net: string; readonly paid: string; readonly outstanding: string };
  readonly expected: { readonly gross: string; readonly net: string; readonly paid: string; readonly outstanding: string; readonly status: string };
  readonly flags: { readonly amounts: boolean; readonly components: boolean; readonly payment: boolean; readonly allocation: boolean };
}

export interface PayrollRepairPreview {
  readonly companyId: string;
  readonly periodId: string;
  readonly periodReference: string;
  readonly period: {
    readonly status: string;
    readonly start: string;
    readonly end: string;
    readonly approvedAt: string | null;
    readonly totals: Readonly<Record<string, string>>;
    readonly expectedTotals: Readonly<Record<string, string>>;
  };
  readonly lines: readonly PayrollLineState[];
  readonly payments: readonly {
    readonly paymentId: string;
    readonly paymentNumber: string;
    readonly status: string;
    readonly totalAmount: string;
    readonly activeAllocated: string;
  }[];
  readonly accounting: {
    readonly enabled: boolean;
    readonly events: readonly {
      readonly eventId: string;
      readonly eventType: string;
      readonly status: string;
      readonly recovery: PayrollRepairability | null;
      readonly classificationCode: string | null;
    }[];
  };
  readonly findings: readonly PayrollRepairFinding[];
  readonly health: PayrollHealthState;
  readonly previewVersion: string;
  readonly requiredPermission: string;
  readonly generatedAt: string;
}

export interface PayrollRepairResult {
  readonly repairExecutionId: string;
  readonly companyId: string;
  readonly periodId: string;
  readonly periodReference: string;
  readonly findingId: string;
  readonly reasonCode: string;
  readonly capabilityCode: string;
  readonly status: "succeeded";
  readonly beforeHealth: string;
  readonly afterHealth: string;
  readonly beforePreviewVersion: string;
  readonly afterPreviewVersion: string;
  readonly executedAt: string;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Repair Center -- consolidated landing + Repair History (Prompt 5).
// ---------------------------------------------------------------------------
export type RepairHistoryResult = "SUCCEEDED" | "REFUSED" | "FAILED" | "REPLAYED";

export interface RepairHistoryCounts {
  readonly succeeded: number;
  readonly failed: number;
  readonly refused: number;
  readonly replayed: number;
  readonly lastRepairAt: string | null;
}

export interface RepairCenterOverview {
  readonly companyId: string;
  readonly company: { readonly code: string; readonly nameEn: string; readonly status: string };
  readonly accountingMode: { readonly enabled: boolean; readonly automaticPostingEnabled: boolean };
  readonly orderHealth: {
    readonly companyHealth: string;
    readonly totalOrders: number;
    readonly healthy: number;
    readonly issue: number;
    readonly review: number;
    readonly scope: { readonly scope: string; readonly dateFrom: string | null; readonly dateTo: string | null };
    /** Phase 6: Order issues whose primary finding is accounting (the same root cause Accounting Health lists). */
    readonly accountingRelatedIssues?: number;
  };
  readonly accountingHealth: {
    readonly accountingHealth: string;
    readonly failed: number;
    readonly blockedConfiguration: number;
    readonly readyCandidates: number;
    readonly blocked: number;
    readonly manualReview: number;
    readonly pending: number;
    readonly processing: number;
    readonly stuck: number;
    readonly historicalWhileOff: number;
    readonly note: string;
    readonly readyCandidateNote: string;
  };
  /** Phase 6: Payroll Health on the landing (absent from an older API). */
  readonly payrollHealth?: {
    readonly payrollHealth: string;
    readonly totalPeriods: number;
    readonly periodsWithFindings: number;
    readonly driverFeeFindings: number;
    readonly headlines: readonly string[];
  } | null;
  /** Phase 6: worst of the domain healths (Accounting NOT_APPLICABLE ignored). */
  readonly companyHealth?: "HEALTHY" | "ISSUE" | "REVIEW";
  readonly repairHistory: RepairHistoryCounts;
  readonly generatedAt: string;
}

export interface RepairHistoryRow {
  readonly kind: "execution" | "attempt";
  readonly id: string;
  readonly occurredAt: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly entityNumber: string | null;
  readonly findingId: string | null;
  readonly reasonCode: string | null;
  readonly capabilityCode: string | null;
  readonly actor: string | null;
  readonly result: RepairHistoryResult;
  readonly reason: string | null;
  readonly outcome: string | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
  readonly repairExecutionId: string | null;
  readonly repairApplied: boolean;
}

export interface RepairHistoryPage {
  readonly items: readonly RepairHistoryRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly generatedAt: string;
}

export interface RepairHistoryQuery {
  readonly result?: RepairHistoryResult;
  readonly capabilityCode?: string;
  readonly entityType?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

// ---------------------------------------------------------------------------
// Company Data Reset (Company Data Reset, Prompt 1): preview -> execute plan.
// ---------------------------------------------------------------------------
export type ResetPreset =
  | "OPERATIONAL_DATA"
  | "FINANCIAL_DATA"
  | "USERS_WORKFORCE"
  | "FULL_COMPANY_DATA_KEEP_COMPANY"
  | "CUSTOM";
export type ResetDomain = "OPERATIONAL" | "FINANCIAL" | "TRADERS_CUSTOMERS" | "WORKFORCE" | "INTEGRATIONS";
export type ResetUserMode = "KEEP_ALL_USERS" | "DELETE_SELECTED_USERS" | "DELETE_ALL_ELIGIBLE_USERS";

export interface CompanyDataResetRequest {
  readonly preset: ResetPreset;
  readonly domains?: readonly ResetDomain[];
  readonly userMode?: ResetUserMode;
  readonly selectedAccountIds?: readonly string[];
  readonly deleteAdminAccountIds?: readonly string[];
  readonly tradersCustomers?: "KEEP" | "RESET";
  readonly workforce?: "KEEP" | "RESET";
}

export interface ResetReferenceCount {
  readonly table: string;
  readonly column: string;
  readonly rows: number;
}

export interface ResetWorkforcePlan {
  readonly kind: "employee" | "driver";
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly action: "DELETE" | "DETACH" | "KEEP" | "DELETE_WITH_DOMAIN";
  readonly reason: string;
  readonly historyReferences: readonly ResetReferenceCount[];
}

export interface ResetUserPlan {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly accountKind: string;
  readonly status: string;
  readonly isCompanyAdmin: boolean;
  /** This Company's role names for the account. */
  readonly roles: readonly string[];
  /** What deleting this account would mean, independent of the current selection. */
  readonly eligibility: { readonly state: "ELIGIBLE" | "PROTECTED" | "SHARED" | "BLOCKED"; readonly reason: string | null };
  readonly classification:
    | "KEEP"
    | "ELIGIBLE"
    | "PROTECTED"
    | "PROTECTED_PLATFORM_ADMIN"
    | "BLOCKED"
    | "SHARED_IDENTITY_PRESERVE"
    | "DEPENDENCY_REVIEW";
  readonly reason: string | null;
  readonly remove: boolean;
  readonly membershipRemoved: number;
  readonly roleAssignmentsRemoved: number;
  readonly employee: ResetWorkforcePlan | null;
  readonly driver: ResetWorkforcePlan | null;
  readonly identity: {
    readonly action: "KEEP" | "DELETE" | "PRESERVE_HISTORY" | "PRESERVE_SHARED";
    readonly references: readonly ResetReferenceCount[];
  };
}

export interface ResetCountPair {
  readonly delete: number;
  readonly preserve: number;
}

export interface CompanyDataResetPlan {
  readonly company: { readonly id: string; readonly code: string; readonly name: string; readonly environment: string };
  readonly effectiveDomains: readonly ResetDomain[];
  readonly requiredDependencies: readonly { readonly domain: ResetDomain; readonly reason: string }[];
  readonly tables: readonly { readonly table: string; readonly domain: ResetDomain; readonly rows: number }[];
  readonly entityLinksRemoved: number;
  readonly users: readonly ResetUserPlan[];
  readonly summary: {
    readonly orders: ResetCountPair;
    readonly collections: ResetCountPair;
    readonly settlements: ResetCountPair;
    readonly accountingTransactions: ResetCountPair;
    readonly payrollTransactions: ResetCountPair;
    readonly traders: ResetCountPair;
    readonly customers: ResetCountPair;
    readonly employees: ResetCountPair;
    readonly drivers: ResetCountPair;
    readonly companyUsers: ResetCountPair;
    readonly roleAssignmentsDeleted: number;
    readonly membershipsDeleted: number;
    readonly globalIdentities: ResetCountPair;
    readonly protectedAdmins: number;
    readonly sharedIdentitiesPreserved: number;
    readonly platformRepairExecutions: "PRESERVE";
    readonly platformRepairAttempts: "PRESERVE";
    readonly generalAudit: "PRESERVE";
    readonly referenceCounters: "PRESERVE";
  };
  readonly fiscalCalendar: {
    readonly fiscalYearsPreserved: number;
    readonly periodsPreserved: number;
    readonly fiscalYearsToOpen: number;
    readonly periodsToOpen: number;
  };
  /** The Company's last executed reset (audit reference), or null. */
  readonly lastReset: { readonly auditEventId: string; readonly at: string } | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly executable: boolean;
  readonly confirmation: string;
  readonly planVersion: string;
}

export interface CompanyDataResetExecution {
  readonly company: { readonly id: string; readonly code: string; readonly name: string };
  readonly planVersion: string;
  readonly preset: ResetPreset;
  readonly effectiveDomains: readonly ResetDomain[];
  readonly totalRemoved: number;
  readonly identitiesDeleted: number;
  readonly identitiesPreserved: number;
  readonly employeesDeleted: number;
  readonly employeesDetached: number;
  readonly driversDeleted: number;
  readonly driversDetached: number;
  readonly entityLinksRemoved: number;
  readonly integrityChecks: readonly string[];
  readonly fiscalYearsOpened: number;
  readonly periodsOpened: number;
  readonly backupFile: string;
  readonly backupSha256: string;
  readonly backupBytes: number;
  /** The reset audit row (audit_events.id) and the request correlation id. */
  readonly auditEventId: string;
  readonly correlationId: string;
}

export interface RepairHistoryDetail extends RepairHistoryRow {
  readonly companyId: string;
  readonly actorAuthority: string;
  readonly previewVersion: string | null;
  readonly repairAppliedStatement: string;
  readonly execution: {
    readonly beforeFingerprint: string;
    readonly afterFingerprint: string;
    readonly beforeHealth: string;
    readonly afterHealth: string;
    readonly beforeClassification: string;
    readonly afterClassification: string;
    readonly outcome: Readonly<Record<string, string | number | boolean | null>>;
    readonly replays: number;
  } | null;
}

function orderHealthQuery(query: OrderHealthListQuery): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(name, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
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

  async announcements(): Promise<PlatformAnnouncement[]> {
    const result = await request<PlatformAnnouncement[]>("platform/announcements", {
      method: "GET",
    });
    return Array.isArray(result) ? result : [];
  },

  async createAnnouncement(payload: SaveAnnouncementPayload): Promise<PlatformAnnouncement> {
    const result = await request<PlatformAnnouncement>("platform/announcements", {
      body: payload,
      method: "POST",
    });
    if (result === undefined) throw new PlatformApiError("Empty announcement response", "empty", 500);
    return result;
  },

  async updateAnnouncement(
    id: string,
    payload: SaveAnnouncementPayload,
  ): Promise<PlatformAnnouncement> {
    const result = await request<PlatformAnnouncement>(`platform/announcements/${id}`, {
      body: payload,
      method: "PUT",
    });
    if (result === undefined) throw new PlatformApiError("Empty announcement response", "empty", 500);
    return result;
  },

  async endAnnouncementNow(id: string): Promise<PlatformAnnouncement> {
    const result = await request<PlatformAnnouncement>(`platform/announcements/${id}/end-now`, {
      method: "POST",
    });
    if (result === undefined) throw new PlatformApiError("Empty announcement response", "empty", 500);
    return result;
  },

  async cancelAnnouncement(id: string): Promise<PlatformAnnouncement> {
    const result = await request<PlatformAnnouncement>(`platform/announcements/${id}/cancel`, {
      method: "POST",
    });
    if (result === undefined) throw new PlatformApiError("Empty announcement response", "empty", 500);
    return result;
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
      throw await uploadError(response, "Website media must be MP4, JPG, PNG, or WebP.");
    }
    return await response.json();
  },
  // Uploads a Company Website branding image (logo override or homepage
  // banner) to Cloudflare R2 and returns its public URL, instead of the
  // editor encoding the file to a base64 data URL and saving it inline in
  // the Website settings. Inline base64 previously made the public Website
  // payload multi-megabyte, since it's re-sent on every page load.
  async uploadCompanyWebsiteMedia(companyId: string, file: File): Promise<{ url: string }> {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
      `${platformConfiguration.apiBaseUrl}/platform/companies/${companyId}/website/media`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "X-Blueline-Session": "cookie" },
        body: form,
      },
    );
    if (!response.ok) {
      let message = "The image could not be uploaded.";
      try {
        const body = await response.json();
        if (typeof body?.error?.message === "string") message = body.error.message;
      } catch {
        // Ignore a non-JSON error body and fall back to the generic message.
      }
      throw new PlatformApiError(message, "website_media_upload_failed", response.status);
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

  // Repair Center: every call names the Company explicitly by its UUID.
  async orderHealthSummary(
    companyId: string,
    query: OrderHealthScopeQuery = {},
  ): Promise<CompanyOrderHealthSummary> {
    const result = await request<CompanyOrderHealthSummary>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/health/orders/summary${orderHealthQuery(query)}`,
      { method: "GET", timeoutMs: 60_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async orderHealthList(
    companyId: string,
    query: OrderHealthListQuery = {},
  ): Promise<CompanyOrderHealthPage> {
    const result = await request<CompanyOrderHealthPage>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/health/orders${orderHealthQuery(query)}`,
      { method: "GET", timeoutMs: 60_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async verifyOrder(companyId: string, orderId: string): Promise<OrderVerification> {
    const result = await request<OrderVerification>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/orders/${encodeURIComponent(orderId)}/verify`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Finding Details: every recomputed finding of one Order (read-only). */
  async orderFindings(companyId: string, orderId: string): Promise<OrderRepairFindings> {
    const result = await request<OrderRepairFindings>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/orders/${encodeURIComponent(orderId)}/findings`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Repair Plan Preview: POST only to carry the reason code; never mutates. */
  async repairPreview(companyId: string, orderId: string, reasonCode?: string): Promise<RepairPlanPreview> {
    const result = await request<RepairPlanPreview>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/orders/${encodeURIComponent(orderId)}/repair-preview`,
      { body: reasonCode === undefined ? {} : { reasonCode }, method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /**
   * Execute ONE certified, READY repair. The caller keeps `idempotencyKey`
   * for the whole attempt so a retry can never repair twice.
   */
  async executeRepair(
    companyId: string,
    orderId: string,
    body: RepairExecutionRequest,
  ): Promise<RepairExecutionResult> {
    const result = await request<RepairExecutionResult>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/orders/${encodeURIComponent(orderId)}/execute`,
      { body, method: "POST", timeoutMs: 60_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async accountingHealthSummary(companyId: string): Promise<AccountingHealthSummary> {
    const result = await request<AccountingHealthSummary>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/accounting/health/summary`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async accountingHealthEvents(companyId: string, query: AccountingHealthQuery = {}): Promise<AccountingHealthPage> {
    const result = await request<AccountingHealthPage>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/accounting/health/events${orderHealthQuery(query as OrderHealthListQuery)}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Phase 4 Prompt 1: journal-integrity and missing-required-event findings (read-only). */
  async accountingHealthIntegrity(companyId: string, query: AccountingIntegrityQuery = {}): Promise<AccountingIntegrityPage> {
    const result = await request<AccountingIntegrityPage>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/accounting/health/integrity${orderHealthQuery(query as OrderHealthListQuery)}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async accountingEventDetails(companyId: string, eventId: string): Promise<AccountingEventDetails> {
    const result = await request<AccountingEventDetails>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/accounting/events/${encodeURIComponent(eventId)}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Recovery preview: POST without parameters; never mutates. */
  async accountingRecoveryPreview(companyId: string, eventId: string): Promise<AccountingRecoveryPreview> {
    const result = await request<AccountingRecoveryPreview>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/accounting/events/${encodeURIComponent(eventId)}/repair-preview`,
      { body: {}, method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Execute ONE READY accounting recovery; keep `idempotencyKey` for the whole attempt. */
  async executeAccountingRecovery(
    companyId: string,
    eventId: string,
    body: RepairExecutionRequest,
  ): Promise<AccountingRecoveryResult> {
    const result = await request<AccountingRecoveryResult>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/accounting/events/${encodeURIComponent(eventId)}/execute`,
      { body, method: "POST", timeoutMs: 60_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async payrollHealthSummary(companyId: string): Promise<PayrollHealthSummary> {
    const result = await request<PayrollHealthSummary>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/payroll/health/summary`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async payrollHealthFindings(companyId: string, query: PayrollHealthQuery = {}): Promise<PayrollHealthPage> {
    const result = await request<PayrollHealthPage>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/payroll/health/findings${orderHealthQuery(query as OrderHealthListQuery)}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Payroll repair preview for ONE period: POST without parameters; never mutates. */
  async payrollRepairPreview(companyId: string, periodId: string): Promise<PayrollRepairPreview> {
    const result = await request<PayrollRepairPreview>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/payroll/periods/${encodeURIComponent(periodId)}/repair-preview`,
      { body: {}, method: "POST" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Execute ONE READY Payroll repair; keep `idempotencyKey` for the whole attempt. */
  async executePayrollRepair(
    companyId: string,
    periodId: string,
    body: RepairExecutionRequest,
  ): Promise<PayrollRepairResult> {
    const result = await request<PayrollRepairResult>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/payroll/periods/${encodeURIComponent(periodId)}/execute`,
      { body, method: "POST", timeoutMs: 60_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async repairCenterOverview(companyId: string): Promise<RepairCenterOverview> {
    const result = await request<RepairCenterOverview>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/overview`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async repairHistory(companyId: string, query: RepairHistoryQuery = {}): Promise<RepairHistoryPage> {
    const result = await request<RepairHistoryPage>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/history${orderHealthQuery(query as OrderHealthListQuery)}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async companyDataResetPreview(companyId: string, body: CompanyDataResetRequest): Promise<CompanyDataResetPlan> {
    const result = await request<CompanyDataResetPlan>(
      `platform/companies/${encodeURIComponent(companyId)}/data-reset/preview`,
      { body, method: "POST", timeoutMs: 60_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  /** Executes exactly the previewed plan; a changed Company returns 409 reset_plan_stale. */
  async companyDataResetExecute(
    companyId: string,
    body: CompanyDataResetRequest & { readonly planVersion: string; readonly confirmation: string },
  ): Promise<CompanyDataResetExecution> {
    const result = await request<CompanyDataResetExecution>(
      `platform/companies/${encodeURIComponent(companyId)}/data-reset/execute`,
      { body, method: "POST", timeoutMs: 310_000 },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
    return result;
  },

  async repairHistoryRecord(
    companyId: string,
    kind: "execution" | "attempt",
    recordId: string,
  ): Promise<RepairHistoryDetail> {
    const result = await request<RepairHistoryDetail>(
      `platform/companies/${encodeURIComponent(companyId)}/repair-center/history/${kind}/${encodeURIComponent(recordId)}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty response", "empty_response", 0);
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

  async verifyCompanyIntegrity(companyId: string, includeAccepted = false): Promise<CompanyIntegrityReport> {
    const query = includeAccepted ? "?includeAccepted=true" : "";
    const result = await request<CompanyIntegrityReport>(
      `platform/integrity/companies/${encodeURIComponent(companyId)}/verify${query}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty integrity response", "empty_response", 0);
    return result;
  },

  async acceptIntegrityFinding(companyId: string, body: { check_code: string; subject_type: string; subject_id: string; fingerprint: string; note: string }): Promise<void> {
    await request(`platform/integrity/companies/${encodeURIComponent(companyId)}/acceptances`, { method: "POST", body });
  },

  async unacceptIntegrityFinding(companyId: string, id: string): Promise<void> {
    await request(`platform/integrity/companies/${encodeURIComponent(companyId)}/acceptances/${encodeURIComponent(id)}`, { method: "DELETE" });
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

  async proposeCompanyWebsiteAiSetup(
    companyId: string,
    payload: {
      companyName: string;
      phoneWhatsapp: string;
      additionalDetails?: string;
      logoUrl?: string;
    },
  ): Promise<{ proposal: CompanyWebsiteAiProposal; provider: "openai"; model: string }> {
    const result = await request<{
      proposal: CompanyWebsiteAiProposal;
      provider: "openai";
      model: string;
    }>(`platform/companies/${companyId}/website/ai-setup/propose`, {
      body: payload,
      method: "POST",
      timeoutMs: 60_000,
    });
    if (!result) throw new PlatformApiError("Empty AI Website Setup response", "empty", 500);
    return result;
  },

  async companyWhatsApp(companyId: string): Promise<CompanyWhatsAppOverview> {
    const result = await request<CompanyWhatsAppOverview>(
      `platform/companies/${companyId}/whatsapp`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty WhatsApp response", "empty", 500);
    return result;
  },

  async setCompanyWhatsAppEnabled(
    companyId: string,
    enabled: boolean,
    reason?: string,
  ): Promise<CompanyWhatsAppOverview> {
    const result = await request<CompanyWhatsAppOverview>(
      `platform/companies/${companyId}/whatsapp/enabled`,
      { body: { enabled, ...(reason === undefined ? {} : { reason }) }, method: "PUT" },
    );
    if (result === undefined) throw new PlatformApiError("Empty WhatsApp response", "empty", 500);
    return result;
  },

  async companyMobileApp(companyId: string): Promise<CompanyMobileApp> {
    const result = await request<CompanyMobileApp>(`platform/companies/${companyId}/mobile-app`, {
      method: "GET",
    });
    if (result === undefined) throw new PlatformApiError("Empty mobile app response", "empty", 500);
    return result;
  },

  async updateCompanyMobileApp(
    companyId: string,
    input: { isEnabled: boolean; reason?: string },
  ): Promise<CompanyMobileApp> {
    const result = await request<CompanyMobileApp>(`platform/companies/${companyId}/mobile-app`, {
      body: input,
      method: "PUT",
    });
    if (result === undefined) throw new PlatformApiError("Empty mobile app response", "empty", 500);
    return result;
  },

  async companyOrdersAi(companyId: string): Promise<CompanyOrdersAi> {
    const result = await request<CompanyOrdersAi>(`platform/companies/${companyId}/orders-ai`, {
      method: "GET",
    });
    if (result === undefined) throw new PlatformApiError("Empty Orders AI response", "empty", 500);
    return result;
  },

  async updateCompanyOrdersAi(
    companyId: string,
    input: { isEnabled: boolean; expectedVersion: number },
  ): Promise<CompanyOrdersAi> {
    const result = await request<CompanyOrdersAi>(`platform/companies/${companyId}/orders-ai`, {
      body: input,
      method: "PUT",
    });
    if (result === undefined) throw new PlatformApiError("Empty Orders AI response", "empty", 500);
    return result;
  },

  async companyRouteOptimization(companyId: string): Promise<CompanyRouteOptimization> {
    const result = await request<CompanyRouteOptimization>(
      `platform/companies/${companyId}/route-optimization`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty route planning response", "empty", 500);
    return result;
  },

  async updateCompanyRouteOptimization(
    companyId: string,
    input: { isEnabled: boolean; dailyCallBudget: number; expectedVersion: number },
  ): Promise<CompanyRouteOptimization> {
    const result = await request<CompanyRouteOptimization>(
      `platform/companies/${companyId}/route-optimization`,
      { body: input, method: "PUT" },
    );
    if (result === undefined) throw new PlatformApiError("Empty route planning response", "empty", 500);
    return result;
  },

  async routeKillSwitch(): Promise<RouteKillSwitch> {
    const result = await request<RouteKillSwitch>("platform/route-optimization/kill-switch", {
      method: "GET",
    });
    if (result === undefined) throw new PlatformApiError("Empty kill switch response", "empty", 500);
    return result;
  },

  async configureRouteKillSwitch(input: { isEnabled: boolean; note?: string }): Promise<RouteKillSwitch> {
    const result = await request<RouteKillSwitch>("platform/route-optimization/kill-switch", {
      body: input,
      method: "PUT",
    });
    if (result === undefined) throw new PlatformApiError("Empty kill switch response", "empty", 500);
    return result;
  },

  async setCompanyWhatsAppStatuses(
    companyId: string,
    statuses: string[],
  ): Promise<CompanyWhatsAppOverview> {
    const result = await request<CompanyWhatsAppOverview>(
      `platform/companies/${companyId}/whatsapp/statuses`,
      { body: { statuses }, method: "PUT" },
    );
    if (result === undefined) throw new PlatformApiError("Empty WhatsApp response", "empty", 500);
    return result;
  },

  async updateCompanyWhatsAppTemplate(
    companyId: string,
    status: string,
    payload: { bodyAr: string; bodyEn: string },
  ): Promise<CompanyWhatsAppOverview> {
    const result = await request<CompanyWhatsAppOverview>(
      `platform/companies/${companyId}/whatsapp/templates/${encodeURIComponent(status)}`,
      { body: payload, method: "PUT" },
    );
    if (result === undefined) throw new PlatformApiError("Empty WhatsApp response", "empty", 500);
    return result;
  },

  async resetCompanyWhatsAppTemplate(
    companyId: string,
    status: string,
  ): Promise<CompanyWhatsAppOverview> {
    const result = await request<CompanyWhatsAppOverview>(
      `platform/companies/${companyId}/whatsapp/templates/${encodeURIComponent(status)}`,
      { method: "DELETE" },
    );
    if (result === undefined) throw new PlatformApiError("Empty WhatsApp response", "empty", 500);
    return result;
  },

  async companyWhatsAppMessages(
    companyId: string,
    filters: { from?: string; to?: string; page?: number; pageSize?: number } = {},
  ): Promise<CompanyWhatsAppMessagesPage> {
    const query = new URLSearchParams();
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    if (filters.page !== undefined) query.set("page", String(filters.page));
    if (filters.pageSize !== undefined) query.set("pageSize", String(filters.pageSize));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const result = await request<CompanyWhatsAppMessagesPage>(
      `platform/companies/${companyId}/whatsapp/messages${suffix}`,
      { method: "GET" },
    );
    if (result === undefined) throw new PlatformApiError("Empty WhatsApp response", "empty", 500);
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

  /** Apply an approved setup template to a draft Company created without one. */
  async applySetupTemplate(
    companyId: string,
    templateCode: string,
    templateVersion: number,
  ): Promise<void> {
    await request(`platform/companies/${companyId}/accounting-setup/apply`, {
      body: { accountingTemplateCode: templateCode, accountingTemplateVersion: templateVersion },
      method: "POST",
    });
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
    confirmedPrefix: string,
  ): Promise<void> {
    await request(`platform/companies/${companyId}/shipment-serial/activate`, {
      body: { confirmedPrefix, reason, expectedVersion },
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
  async importBlogArticle(file: File | null, googleDocUrl: string): Promise<{ fields: Record<string, string>; warnings: string[] }> {
    const body = new FormData();
    if (file) body.append("file", file);
    else body.append("googleDocUrl", googleDocUrl.trim());
    return (await request<{ fields: Record<string, string>; warnings: string[] }>("platform/blog/import", { method: "POST", body, timeoutMs: 30000 }))!;
  },
  async blogArticle(id: string): Promise<any> {
    return await request<any>(`platform/blog/articles/${id}`, { method: "GET" });
  },
  async deleteBlogArticle(id: string): Promise<void> {
    await request<void>(`platform/blog/articles/${id}`, { method: "DELETE" });
  },
  async blogArticlePreview(id: string): Promise<any> {
    return await request<any>(`platform/blog/articles/${id}/preview`, { method: "GET" });
  },
  async blogReferences(): Promise<any> {
    return await request<any>("platform/blog/references", { method: "GET" });
  },
  async blogSeoHealth():Promise<any>{return await request<any>("platform/blog/seo-health",{method:"GET"});},
  async blogProductionSeoHealth():Promise<any>{return await request<any>("platform/blog/production-seo-health",{method:"GET"});},
  async blogSeoReadiness(id:string):Promise<any>{return await request<any>(`platform/blog/articles/${id}/seo-readiness`,{method:"GET"});},
  async blogRedirects():Promise<any[]>{return(await request<any[]>("platform/blog/redirects",{method:"GET"}))??[];},
  async blogNotFoundPaths():Promise<any[]>{return(await request<any[]>("platform/blog/not-found",{method:"GET"}))??[];},
  async createBlogCategory(body:any):Promise<any>{return await request<any>("platform/blog/categories",{method:"POST",body});},
  async updateBlogCategory(id:string,body:any):Promise<any>{return await request<any>(`platform/blog/categories/${id}`,{method:"PATCH",body});},
  async saveBlogTag(id:string|undefined,body:any):Promise<any>{return await request<any>(id?`platform/blog/tags/${id}`:"platform/blog/tags",{method:id?"PATCH":"POST",body});},
  async saveBlogAuthor(id:string|undefined,body:any):Promise<any>{return await request<any>(id?`platform/blog/authors/${id}`:"platform/blog/authors",{method:id?"PATCH":"POST",body});},
  async saveBlogTopic(id:string|undefined,body:any):Promise<any>{return await request<any>(id?`platform/blog/topics/${id}`:"platform/blog/topics",{method:id?"PATCH":"POST",body});},
  async createBlogRedirect(body:any):Promise<any>{return await request<any>("platform/blog/redirects",{method:"POST",body});},
  async createBlogArticle(input: any): Promise<any> {
    return await request<any>("platform/blog", { method: "POST", body: input });
  },
  async updateBlogArticle(id: string, input: any): Promise<any> {
    return await request<any>(`platform/blog/articles/${id}`, { method: "PATCH", body: input });
  },
  async updateBlogArticleStatus(id: string, input: any): Promise<any> {
    return await request<any>(`platform/blog/articles/${id}/status`, { method: "PATCH", body: input });
  },
  async seoGuides(): Promise<any[]> {
    return (await request<any[]>("platform/seo-guides", { method: "GET" })) ?? [];
  },
  async seoGuide(id: string): Promise<any> {
    return await request<any>(`platform/seo-guides/${id}`, { method: "GET" });
  },
  async createSeoGuide(input: any): Promise<any> {
    return await request<any>("platform/seo-guides", { method: "POST", body: input });
  },
  async updateSeoGuide(id: string, input: any): Promise<any> {
    return await request<any>(`platform/seo-guides/${id}`, { method: "PATCH", body: input });
  },
  async updateSeoGuideStatus(id: string, input: any): Promise<any> {
    return await request<any>(`platform/seo-guides/${id}/status`, { method: "PATCH", body: input });
  },
  async seoGuideReadiness(id: string): Promise<any> {
    return await request<any>(`platform/seo-guides/${id}/seo-readiness`, { method: "GET" });
  },
  async uploadSeoGuideSource(id: string, file: File): Promise<any> {
    const body = new FormData();
    body.append("file", file);
    return await request<any>(`platform/seo-guides/${id}/sources`, { method: "POST", body, timeoutMs: 30_000 });
  },
  seoGuideSourceDownloadUrl(id: string, sourceId: string): string {
    return `${platformConfiguration.apiBaseUrl}/platform/seo-guides/${id}/sources/${sourceId}/download`;
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
  async updateAgentAvatarSettings(input: any): Promise<any> {
    return await request<any>("platform/agent/avatar/settings", { method: "PATCH", body: input });
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
