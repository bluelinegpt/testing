export type AnalyticsEventName =
  | "page_view"
  | "pricing_viewed"
  | "pricing_cta_clicked"
  | "cta_clicked"
  | "request_demo_clicked"
  | "demo_request_started"
  | "demo_request_submitted"
  | "demo_form_started"
  | "demo_form_validation_error"
  | "demo_form_submitted"
  | "demo_form_success"
  | "demo_form_failed"
  | "delivery_quote_started"
  | "delivery_quote_submitted"
  | "send_package_page_view"
  | "customer_quote_started"
  | "customer_quote_step_completed"
  | "customer_quote_validation_error"
  | "customer_quote_submitted"
  | "customer_quote_instant"
  | "customer_quote_custom_required"
  | "customer_quote_no_service"
  | "customer_quote_offer_selected"
  | "customer_quote_expired"
  | "trader_application_started"
  | "trader_application_step_completed"
  | "trader_application_validation_error"
  | "trader_application_submitted"
  | "trader_application_success"
  | "trader_application_failed"
  | "whatsapp_contact_started"
  | "agent_opened"
  | "agent_conversation_started"
  | "agent_business_intent_detected"
  | "agent_intent_detected"
  | "agent_handoff_requested"
  | "agent_whatsapp_handoff_started"
  | "agent_quote_created"
  | "agent_quote_started"
  | "agent_quote_generated"
  | "agent_custom_quote_created"
  | "agent_trader_application_started"
  | "agent_trader_application_success"
  | "agent_demo_created"
  | "agent_demo_request_started"
  | "agent_demo_request_success"
  | "agent_handoff_created"
  | "agent_error"
  | "delivery_company_page_view"
  | "trader_page_view"
  | "trader_registration_clicked"
  | "blog_view"
  | "blog_article_view"
  | "blog_category_view"
  | "blog_internal_link_clicked"
  | "blog_cta_clicked"
  | "contact_form_submitted"
  | "tracking_started"
  | "tracking_verification_required"
  | "tracking_success"
  | "tracking_failed";

export type SafeMetadata = {
  page?: string | undefined;
  locale?: "en" | "ar" | string | undefined;
  language?: "en" | "ar" | string | undefined;
  source?: string | undefined;
  sourcePage?: string | undefined;
  source_page?: string | undefined;
  ctaId?: string | undefined;
  cta_id?: string | undefined;
  ctaLocation?: string | undefined;
  cta_location?: string | undefined;
  destinationType?: "internal" | "whatsapp" | "phone" | "email" | "external" | undefined;
  destination_type?: "internal" | "whatsapp" | "phone" | "email" | "external" | undefined;
  audience?: "customer" | "trader" | "delivery_company" | "unknown" | string | undefined;
  lead_type?: "delivery_company" | "trader" | "customer" | string | undefined;
  country?: string | undefined;
  step?: number | string | undefined;
  primaryCategory?: string | undefined;
  business_category?: string | undefined;
  monthlyOrderRange?: string | undefined;
  hasExistingDeliveryCompany?: boolean | undefined;
  salesChannelCount?: number | undefined;
  pickup_country?: string | undefined;
  delivery_country?: string | undefined;
  quote_route_type?: "domestic" | "international" | undefined;
  quote_outcome?: "instant" | "manual" | "no_service" | undefined;
  pickup_emirate?: string | undefined;
  delivery_emirate?: string | undefined;
  package_category?: string | undefined;
  package_type?: string | undefined;
  service_type?: string | undefined;
  cod_required?: boolean | undefined;
  number_of_offers?: number | undefined;
  plan_name?: string | undefined;
  cta_type?: string | undefined;
  article_slug?: string | undefined;
  category_slug?: string | undefined;
  channel?: "website" | "whatsapp" | "simulator" | undefined;
  initiated_from?: "agent" | "website_cta" | string | undefined;
  intent?: string | undefined;
  classification?: string | undefined;
  actionResult?: string | undefined;
  reference?: string | undefined;
  demo_reference?: string | undefined;
  quote_reference?: string | undefined;
  trader_application_reference?: string | undefined;
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
  utmCampaign?: string | undefined;
  utmTerm?: string | undefined;
  utmContent?: string | undefined;
  gclid?: string | undefined;
  surface?: "homepage" | "track_page" | string | undefined;
  outcome?:
    | "verified"
    | "verification_required"
    | "not_found"
    | "not_verified"
    | "ambiguous"
    | string
    | undefined;
};

type AnalyticsPayload = Record<string, string | number | boolean | undefined>;

const attributionKey = "tawseelhub.marketing_attribution";
const dedupePrefix = "tawseelhub.analytics.sent.";
const consentKey = "tawseelhub.analytics_consent";
const piiPattern =
  /(email|mobile|phone|name|address|recipient|receiver|contactPerson|transcript|message|comment|challenge|notes|freeText)/i;
const allowedReference = /^(DEMO|QTE|TRD-APP|HAND|AGT)-\d{6}$/;
const campaignKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
] as const;

declare global {
  interface Window {
    dataLayer?: unknown[];
    __TAWSEELHUB_ANALYTICS_ENABLED__?: boolean;
    __TAWSEELHUB_ANALYTICS_EVENTS__?: unknown[];
  }
}

function cleanText(value: string | undefined, max = 160): string | undefined {
  const text = value?.replace(/[<>]/g, "").trim();
  return text ? text.slice(0, max) : undefined;
}

function locale(): string {
  return document.documentElement.lang === "ar" ? "ar" : "en";
}

function analyticsConsentAllowed(): boolean {
  try {
    return window.localStorage.getItem(consentKey) !== "denied";
  } catch {
    return true;
  }
}

function trackingAllowed(): boolean {
  return window.__TAWSEELHUB_ANALYTICS_ENABLED__ === true && analyticsConsentAllowed();
}

export function setAnalyticsTrackingEnabled(enabled: boolean) {
  window.__TAWSEELHUB_ANALYTICS_ENABLED__ = enabled;
}

export function setAnalyticsConsent(consent: "granted" | "denied") {
  try {
    window.localStorage.setItem(consentKey, consent);
  } catch {
    // Analytics preferences are best-effort only; storage failures must not break the website.
  }
}

export function captureAttribution(search = window.location.search) {
  const query = new URLSearchParams(search);
  const attribution: Record<string, string> = {};
  for (const key of campaignKeys) {
    const value = cleanText(query.get(key) ?? undefined, key === "gclid" ? 200 : 120);
    if (value) attribution[key] = value;
  }
  if (Object.keys(attribution).length === 0) return;
  attribution.landing_page = window.location.pathname;
  attribution.first_seen_at = new Date().toISOString();
  try {
    window.sessionStorage.setItem(attributionKey, JSON.stringify(attribution));
  } catch {
    // Attribution capture is best-effort only.
  }
}

export function currentAttribution(search = window.location.search): SafeMetadata {
  captureAttribution(search);
  let parsed: Record<string, string> = {};
  try {
    const stored = window.sessionStorage.getItem(attributionKey);
    parsed = stored ? (JSON.parse(stored) as Record<string, string>) : {};
  } catch {
    parsed = {};
  }
  return {
    utmSource: parsed.utm_source,
    utmMedium: parsed.utm_medium,
    utmCampaign: parsed.utm_campaign,
    utmContent: parsed.utm_content,
    utmTerm: parsed.utm_term,
    gclid: parsed.gclid,
  };
}

export function leadAttribution(search = window.location.search) {
  const attribution = currentAttribution(search);
  return {
    referrer: document.referrer || undefined,
    utmSource: attribution.utmSource,
    utmMedium: attribution.utmMedium,
    utmCampaign: attribution.utmCampaign,
    utmContent: attribution.utmContent,
    utmTerm: attribution.utmTerm,
    gclid: attribution.gclid,
  };
}

export function utmMetadata(search = window.location.search): SafeMetadata {
  const attribution = currentAttribution(search);
  return {
    utmSource: attribution.utmSource,
    utmMedium: attribution.utmMedium,
    utmCampaign: attribution.utmCampaign,
  };
}

function normalizeMetadata(metadata: SafeMetadata): AnalyticsPayload {
  const safe: AnalyticsPayload = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null || value === "") continue;
    if (piiPattern.test(key)) continue;
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (typeof value === "string") {
      const cleaned = cleanText(value, 200);
      if (!cleaned) continue;
      if (snake.includes("reference") && !allowedReference.test(cleaned)) continue;
      safe[snake] = cleaned;
    } else if (typeof value === "number" || typeof value === "boolean") {
      safe[snake] = value;
    }
  }
  return safe;
}

function eventId(name: string, reference?: string): string {
  const source = reference
    ? `${name}:${reference}`
    : `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1)
    hash = (Math.imul(31, hash) + source.charCodeAt(index)) | 0;
  return `evt_${Math.abs(hash).toString(36)}`;
}

function appendDebugEvent(event: Record<string, unknown>) {
  const id = "tawseelhub-analytics-debug";
  let element = document.getElementById(id) as HTMLScriptElement | null;
  if (!element) {
    element = document.createElement("script");
    element.id = id;
    element.type = "application/json";
    element.setAttribute("data-purpose", "safe-analytics-debug");
    document.head.append(element);
  }
  let previous: unknown[] = [];
  try {
    previous = element.textContent ? (JSON.parse(element.textContent) as unknown[]) : [];
  } catch {
    previous = [];
  }
  element.textContent = JSON.stringify([...previous, event]);
}

export function trackEvent(name: AnalyticsEventName, metadata: SafeMetadata = {}) {
  const safe = normalizeMetadata({
    page: window.location.pathname,
    locale: locale(),
    ...currentAttribution(),
    ...metadata,
  });
  const reference = String(
    safe.reference ??
      safe.demo_reference ??
      safe.quote_reference ??
      safe.trader_application_reference ??
      "",
  );
  const event = {
    event: name,
    event_id: eventId(name, reference || undefined),
    occurred_at: new Date().toISOString(),
    ...safe,
  };
  window.__TAWSEELHUB_ANALYTICS_EVENTS__ = [
    ...(window.__TAWSEELHUB_ANALYTICS_EVENTS__ ?? []),
    event,
  ];
  appendDebugEvent(event);
  window.dispatchEvent(new CustomEvent("tawseelhub:analytics", { detail: event }));
  try {
    if (trackingAllowed()) window.dataLayer?.push(event);
  } catch {
    // Third-party analytics must never affect the public user journey.
  }
  return event;
}

export function trackConversionOnce(
  name: AnalyticsEventName,
  reference: string,
  metadata: SafeMetadata = {},
) {
  if (!allowedReference.test(reference)) return undefined;
  const key = `${dedupePrefix}${name}.${reference}`;
  try {
    if (window.sessionStorage.getItem(key)) return undefined;
    window.sessionStorage.setItem(key, "true");
  } catch {
    // If session storage is unavailable, still report the conversion once for this call.
  }
  return trackEvent(name, { ...metadata, reference });
}
