import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  renderCompanyWebsiteTemplate,
  type CompanyWebsiteTemplateKey,
} from "./CompanyWebsiteTemplates.js";
import { isAllowedCompanyWebsitePreviewParent } from "./preview-origin.js";

export interface PublicWebsitePayload {
  availability: "published" | "disabled";
  slug: string;
  defaultLocale?: "en" | "ar";
  templateKey?: CompanyWebsiteTemplateKey;
  canonicalUrl?: string;
  redirectTo?: string;
  settings?: WebsiteSettings;
  company?: {
    nameEn: string;
    nameAr: string | null;
    subtitleEn: string | null;
    subtitleAr: string | null;
    telephone: string | null;
    email: string | null;
    addressEn: string | null;
    addressAr: string | null;
    hasLogo: boolean;
  };
}

interface Localized {
  en?: string;
  ar?: string;
}
interface WebsiteSettings {
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
  presentation: Record<string, Localized | string | undefined>;
  contact: {
    phone?: string;
    mobile?: string;
    email?: string;
    address?: Localized;
    city?: Localized;
    whatsappEnabled: boolean;
    whatsappNumber?: string;
    whatsappMessage?: Localized;
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
    title: Localized;
    description?: Localized;
    enabled: boolean;
    order: number;
  }>;
  coverage: Array<{
    id: string;
    emirate: string;
    emirateAr?: string;
    area?: string;
    areaAr?: string;
    enabled: boolean;
    order: number;
  }>;
  benefits: Array<{
    id: string;
    title: Localized;
    description?: Localized;
    enabled: boolean;
    order: number;
  }>;
  marketing?: {
    steps: Array<{
      id: string;
      title: Localized;
      description?: Localized;
      enabled: boolean;
      order: number;
    }>;
    industries: Array<{
      id: string;
      title: Localized;
      description?: Localized;
      enabled: boolean;
      order: number;
    }>;
    statistics: Array<{
      id: string;
      title: Localized;
      description?: Localized;
      enabled: boolean;
      order: number;
    }>;
    testimonials: Array<{
      id: string;
      title: Localized;
      description?: Localized;
      enabled: boolean;
      order: number;
    }>;
  };
  socialLinks: Record<string, string>;
  sections: Array<{ key: string; enabled: boolean; order: number }>;
  functions?: { trackingEnabled: boolean; requestDeliveryEnabled: boolean };
  seo?: { title?: Localized; description?: Localized; socialImageUrl?: string; indexable: boolean };
  knowledge?: {
    description?: Localized;
    faqs: Array<{
      id: string;
      question: Localized;
      answer: Localized;
      enabled: boolean;
      order: number;
      websiteVisible: boolean;
      agentAvailable: boolean;
    }>;
  };
  agent?: {
    enabled: boolean;
    displayName?: string;
    welcomeMessage?: Localized;
    handoffMessage?: Localized;
    suggestedActions: Array<
      "track" | "request_delivery" | "services" | "coverage" | "contact" | "whatsapp"
    >;
  };
}

const CompanyWebsiteAgent = lazy(() => import("./CompanyWebsiteAgent.js"));

declare const __APP_VERSION__: string;

function apiBase(): string {
  return (
    (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/u, "") ?? "/api/v1"
  );
}

export function simulatedCompanyWebsiteHost(): string | undefined {
  if (!["localhost", "127.0.0.1"].includes(globalThis.location.hostname)) return undefined;
  return (
    new URLSearchParams(globalThis.location.search).get("companyWebsiteHost")?.trim() || undefined
  );
}

function previewBridge<T>(type: string, payload: Record<string, unknown>): Promise<T> {
  const requestId = crypto.randomUUID();
  const parentOrigin = new URL(document.referrer).origin;
  if (!isAllowedCompanyWebsitePreviewParent(parentOrigin))
    return Promise.reject(new Error("preview_parent_not_allowed"));
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      globalThis.removeEventListener("message", receive);
      reject(new Error("preview_timeout"));
    }, 20_000);
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== globalThis.parent ||
        event.origin !== parentOrigin ||
        !event.data ||
        typeof event.data !== "object"
      )
        return;
      const response = event.data as {
        type?: string;
        requestId?: string;
        result?: T;
        error?: boolean;
      };
      if (response.type !== `${type}:result` || response.requestId !== requestId) return;
      globalThis.clearTimeout(timeout);
      globalThis.removeEventListener("message", receive);
      if (response.error || response.result === undefined)
        reject(new Error("preview_request_failed"));
      else resolve(response.result);
    };
    globalThis.addEventListener("message", receive);
    globalThis.parent.postMessage({ type, requestId, ...payload }, parentOrigin);
  });
}

export function isPublicCompanyWebsiteHost(): boolean {
  const simulated = simulatedCompanyWebsiteHost();
  const host = simulated ?? globalThis.location.hostname.toLowerCase();
  // The bare local development origins always belong to the authenticated
  // Company Portal. A public Company Website is simulated explicitly through
  // `companyWebsiteHost`; treating 127.0.0.1 as a custom domain hides login.
  if (
    simulated === undefined &&
    (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost"))
  )
    return false;
  const suffix =
    (import.meta.env.VITE_TENANT_HOST_SUFFIX as string | undefined) ?? "tawseelhub.com";
  if (!host.endsWith(`.${suffix}`))
    return (
      simulated !== undefined ||
      (/^[a-z0-9.-]+$/u.test(host) && host.includes(".") && !host.includes("xn--"))
    );
  const label = host.slice(0, -(suffix.length + 1));
  return (
    !label.includes(".") &&
    !label.endsWith("app") &&
    !new Set([
      "www",
      "api",
      "platform",
      "admin",
      "store",
      "support",
      "help",
      "mail",
      "cdn",
      "assets",
      "static",
    ]).has(label)
  );
}

export function PublicCompanyWebsite({
  previewPayload,
}: { previewPayload?: PublicWebsitePayload } = {}): ReactNode {
  const [payload, setPayload] = useState<PublicWebsitePayload | undefined>(previewPayload);
  const [missing, setMissing] = useState(false);
  const override = simulatedCompanyWebsiteHost();
  useEffect(() => {
    if (previewPayload) return;
    void fetch(
      `${apiBase()}/public/company-website`,
      override ? { headers: { "x-blueline-tenant-host": override } } : {},
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("not_available");
        return response.json() as Promise<PublicWebsitePayload>;
      })
      .then(setPayload)
      .catch(() => setMissing(true));
  }, [override, previewPayload]);
  useEffect(() => {
    if (payload?.redirectTo) {
      const target = new URL(payload.redirectTo);
      target.pathname = location.pathname;
      target.search = location.search;
      target.hash = location.hash;
      location.replace(target.toString());
    }
  }, [payload?.redirectTo]);
  useEffect(() => {
    const robots =
      document.querySelector<HTMLMetaElement>('meta[name="robots"]') ??
      document.head.appendChild(document.createElement("meta"));
    robots.name = "robots";
    const privatePage =
      previewPayload !== undefined || globalThis.location.pathname.startsWith("/track");
    robots.content =
      payload?.availability === "published" &&
      payload.settings?.seo?.indexable !== false &&
      !privatePage
        ? "index,follow"
        : "noindex,nofollow";
    if (payload?.company) {
      const locale = new URLSearchParams(location.search).get("lang") === "ar" ? "ar" : "en";
      const page = location.pathname.startsWith("/track")
        ? locale === "ar"
          ? "تتبع الشحنة"
          : "Track shipment"
        : location.pathname.startsWith("/request-delivery")
          ? locale === "ar"
            ? "اطلب توصيلاً"
            : "Request delivery"
          : location.pathname.startsWith("/contact")
            ? locale === "ar"
              ? "اتصل بنا"
              : "Contact"
            : null;
      const siteTitle =
        payload.settings?.seo?.title?.[locale] ??
        payload.settings?.seo?.title?.en ??
        payload.company.nameEn;
      document.title = page ? `${page} | ${siteTitle}` : siteTitle;
      const description =
        document.querySelector<HTMLMetaElement>('meta[name="description"]') ??
        document.head.appendChild(document.createElement("meta"));
      description.name = "description";
      description.content =
        payload.settings?.seo?.description?.[locale] ??
        payload.settings?.seo?.description?.en ??
        payload.settings?.knowledge?.description?.[locale] ??
        payload.settings?.knowledge?.description?.en ??
        payload.company.subtitleEn ??
        payload.company.nameEn;
      const canonical =
        document.querySelector<HTMLLinkElement>('link[rel="canonical"]') ??
        document.head.appendChild(document.createElement("link"));
      canonical.rel = "canonical";
      canonical.href = `${payload.canonicalUrl ?? `https://${payload.slug}.${(import.meta.env.VITE_TENANT_HOST_SUFFIX as string | undefined) ?? "tawseelhub.com"}`}${location.pathname === "/" ? "" : location.pathname}`;
      const ogUrl =
        document.querySelector<HTMLMetaElement>('meta[property="og:url"]') ??
        document.head.appendChild(document.createElement("meta"));
      ogUrl.setAttribute("property", "og:url");
      ogUrl.content = canonical.href;
      const structured =
        document.querySelector<HTMLScriptElement>("script[data-company-website-structured]") ??
        document.head.appendChild(document.createElement("script"));
      structured.type = "application/ld+json";
      structured.dataset.companyWebsiteStructured = "true";
      structured.text = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: payload.company.nameEn,
        url: payload.canonicalUrl,
        ...(Object.keys(payload.settings?.socialLinks ?? {}).length
          ? { sameAs: Object.values(payload.settings?.socialLinks ?? {}).filter(Boolean) }
          : {}),
        ...(payload.settings?.knowledge?.description?.en
          ? { description: payload.settings.knowledge.description.en }
          : {}),
      });
    }
  }, [payload, previewPayload]);
  if (missing) return <Unavailable />;
  if (!payload) return <main className="company-site company-site--loading">Loading…</main>;
  if (payload.availability === "disabled" || !payload.company) return <Unavailable />;
  const settings = payload.settings;
  const requestedLocale = new URLSearchParams(globalThis.location.search).get("lang");
  const locale: "en" | "ar" =
    requestedLocale === "ar" && settings?.languages.ar
      ? "ar"
      : requestedLocale === "en" && settings?.languages.en
        ? "en"
        : (settings?.languages.defaultLocale ?? payload.defaultLocale ?? "en");
  const company = payload.company;
  const localized = (value: Localized | undefined, fallback: string | null = null) =>
    value?.[locale] ?? value?.en ?? fallback;
  const publicText = (value: string): string =>
    value
      .replace(/^#{1,6}\s*/gmu, "")
      .replace(/\*\*(.*?)\*\*/gu, "$1")
      .replace(/^\s*[*-]\s+/gmu, "• ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  const name =
    localized(
      settings?.presentation.displayName as Localized | undefined,
      locale === "ar" ? (company.nameAr ?? company.nameEn) : company.nameEn,
    ) ?? company.nameEn;
  const subtitle = localized(
    (settings?.presentation.heroSubheadline ?? settings?.presentation.tagline) as
      Localized | undefined,
    locale === "ar" ? (company.subtitleAr ?? company.subtitleEn) : company.subtitleEn,
  );
  const address = settings?.contact.showAddress
    ? [localized(settings.contact.address), localized(settings.contact.city)]
        .filter(Boolean)
        .join(", ") || null
    : null;
  const phone = settings?.contact.showPhone
    ? (settings.contact.phone ?? settings.contact.mobile ?? null)
    : null;
  const email = settings?.contact.showEmail ? (settings.contact.email ?? null) : null;
  const whatsappNumber =
    settings?.contact.whatsappNumber ?? settings?.contact.mobile ?? settings?.contact.phone;
  const whatsappUrl =
    (settings?.contact.whatsappEnabled || settings?.contact.showWhatsapp) && whatsappNumber
      ? `https://wa.me/${whatsappNumber.replace(/\D/gu, "")}${localized(settings.contact.whatsappMessage) ? `?text=${encodeURIComponent(localized(settings.contact.whatsappMessage)!)}` : ""}`
      : null;
  const ctaHref = (type: string | undefined): string =>
    type === "whatsapp" && whatsappUrl
      ? whatsappUrl
      : type === "call" && phone
        ? `tel:${phone.replace(/[^+\d]/gu, "")}`
        : type === "track"
          ? "#tracking"
          : type === "request_delivery"
            ? "#request-delivery"
            : type === "section"
              ? "#about"
              : "#contact";
  const logoUrl =
    settings?.branding.logoDataUrl ??
    (company.hasLogo
      ? `${apiBase()}/public/company-website/logo${override ? `?host=${encodeURIComponent(override)}` : ""}`
      : null);
  return (
    <>
      {renderCompanyWebsiteTemplate(payload.templateKey ?? "corporate", {
        name,
        ...(localized(settings?.presentation.heroHeadline as Localized | undefined)
          ? { headline: localized(settings?.presentation.heroHeadline as Localized | undefined)! }
          : {}),
        description: subtitle ?? null,
        ...(localized(
          (settings?.presentation.about ?? settings?.knowledge?.description) as
            Localized | undefined,
        )
          ? {
              about: publicText(
                localized(
                  (settings?.presentation.about ?? settings?.knowledge?.description) as
                    Localized | undefined,
                )!,
              ),
            }
          : {}),
        phone,
        email,
        address: address ?? null,
        logoUrl,
        bannerUrls:
          locale === "ar" && settings?.branding.bannerDataUrlsAr?.length
            ? settings.branding.bannerDataUrlsAr
            : settings?.branding.bannerDataUrls?.length
              ? settings.branding.bannerDataUrls
              : settings?.branding.bannerDataUrl
                ? [settings.branding.bannerDataUrl]
                : [],
        bannerTransition: settings?.branding.bannerTransition ?? "fade",
        bannerIntervalSeconds: settings?.branding.bannerIntervalSeconds ?? 6,
        direction: locale === "ar" ? "rtl" : "ltr",
        language: locale,
        navigation:
          locale === "ar"
            ? {
                about: "من نحن",
                services: "الخدمات",
                coverage: "نطاق التغطية",
                track: "تتبع",
                request: "اطلب توصيلاً",
                contact: "اتصل بنا",
                suffix: "?lang=ar",
              }
            : {
                about: "About",
                services: "Services",
                coverage: "Coverage",
                track: "Track",
                request: "Request Delivery",
                contact: "Contact",
                suffix: "?lang=en",
              },
        theme: {
          ...(settings?.branding.primaryColor ? { primary: settings.branding.primaryColor } : {}),
          ...(settings?.branding.secondaryColor
            ? { secondary: settings.branding.secondaryColor }
            : {}),
          ...(settings?.branding.accentColor ? { accent: settings.branding.accentColor } : {}),
        },
        services: (settings?.services ?? [])
          .filter((item) => item.enabled)
          .sort((a, b) => a.order - b.order)
          .map((item) => ({
            id: item.id,
            title: localized(item.title) ?? "",
            ...(localized(item.description) ? { description: localized(item.description)! } : {}),
          })),
        coverage: (settings?.coverage ?? [])
          .filter((item) => item.enabled)
          .sort((a, b) => a.order - b.order)
          .map((item) => ({
            ...item,
            emirate: locale === "ar" ? (item.emirateAr ?? item.emirate) : item.emirate,
            ...(locale === "ar" && item.areaAr ? { area: item.areaAr } : {}),
          })),
        benefits: (settings?.benefits ?? [])
          .filter((item) => item.enabled)
          .sort((a, b) => a.order - b.order)
          .map((item) => ({
            id: item.id,
            title: localized(item.title) ?? "",
            ...(localized(item.description) ? { description: localized(item.description)! } : {}),
          })),
        marketing: {
          steps: (settings?.marketing?.steps ?? [])
            .filter((item) => item.enabled)
            .sort((a, b) => a.order - b.order)
            .map((item) => ({
              id: item.id,
              title: localized(item.title) ?? "",
              ...(localized(item.description) ? { description: localized(item.description)! } : {}),
            })),
          industries: (settings?.marketing?.industries ?? [])
            .filter((item) => item.enabled)
            .sort((a, b) => a.order - b.order)
            .map((item) => ({
              id: item.id,
              title: localized(item.title) ?? "",
              ...(localized(item.description) ? { description: localized(item.description)! } : {}),
            })),
          statistics: (settings?.marketing?.statistics ?? [])
            .filter((item) => item.enabled)
            .sort((a, b) => a.order - b.order)
            .map((item) => ({
              id: item.id,
              title: localized(item.title) ?? "",
              ...(localized(item.description) ? { description: localized(item.description)! } : {}),
            })),
          testimonials: (settings?.marketing?.testimonials ?? [])
            .filter((item) => item.enabled)
            .sort((a, b) => a.order - b.order)
            .map((item) => ({
              id: item.id,
              title: localized(item.title) ?? "",
              ...(localized(item.description) ? { description: localized(item.description)! } : {}),
            })),
        },
        workingHours: settings?.contact.showWorkingHours ? settings.contact.workingHours : [],
        socialLinks: settings?.socialLinks ?? {},
        sections: settings?.sections ?? [],
        whatsappUrl,
        ...(localized(settings?.presentation.primaryCtaLabel as Localized | undefined)
          ? {
              primaryCta: {
                label: localized(settings?.presentation.primaryCtaLabel as Localized)!,
                href: ctaHref(settings?.presentation.primaryCtaType as string | undefined),
              },
            }
          : {}),
        ...(localized(settings?.presentation.secondaryCtaLabel as Localized | undefined)
          ? {
              secondaryCta: {
                label: localized(settings?.presentation.secondaryCtaLabel as Localized)!,
                href: ctaHref(settings?.presentation.secondaryCtaType as string | undefined),
              },
            }
          : {}),
        ...(settings?.contact.latitude !== undefined
          ? { latitude: settings.contact.latitude }
          : {}),
        ...(settings?.contact.longitude !== undefined
          ? { longitude: settings.contact.longitude }
          : {}),
        ...(settings?.languages.en && settings.languages.ar
          ? {
              alternateLanguage: {
                label: locale === "en" ? "AR" : "EN",
                url: `?lang=${locale === "en" ? "ar" : "en"}`,
              },
            }
          : {}),
        ...(settings?.functions?.trackingEnabled !== false &&
        settings?.sections.find((section) => section.key === "tracking")?.enabled !== false
          ? {
              trackingSection: (
                <TrackingSection
                  locale={locale}
                  override={override}
                  preview={previewPayload !== undefined}
                />
              ),
            }
          : {}),
      })}
      <PublicFunctions
        locale={locale}
        override={override}
        settings={settings}
        whatsappUrl={whatsappUrl}
      />
      {settings?.knowledge?.faqs.some((faq) => faq.enabled && faq.websiteVisible) ? (
        <section className="company-site-functions" id="faqs" dir={locale === "ar" ? "rtl" : "ltr"}>
          <div className="company-site-function">
            <h2>{locale === "ar" ? "الأسئلة الشائعة" : "Frequently Asked Questions"}</h2>
            {settings.knowledge.faqs
              .filter((faq) => faq.enabled && faq.websiteVisible)
              .sort((a, b) => a.order - b.order)
              .map((faq) => (
                <details key={faq.id}>
                  <summary>{localized(faq.question)}</summary>
                  <p>{localized(faq.answer)}</p>
                </details>
              ))}
          </div>
        </section>
      ) : null}
      {settings?.agent?.enabled ? (
        <Suspense fallback={null}>
          <CompanyWebsiteAgent
            agent={settings.agent}
            apiBase={apiBase()}
            language={locale}
            preview={previewPayload !== undefined}
            {...(override ? { overrideHost: override } : {})}
          />
        </Suspense>
      ) : null}
      {whatsappUrl ? (
        <a
          className="company-site__whatsapp"
          href={whatsappUrl}
          rel="noreferrer"
          target="_blank"
          aria-label={locale === "ar" ? "تواصل عبر واتساب" : "Chat on WhatsApp"}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20.5 11.7a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.4-4.3a8.5 8.5 0 1 1 15.6-4.5Z" />
            <path d="M8.2 7.7c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.8 2c.1.3 0 .5-.2.7l-.7.8c-.2.2-.1.4 0 .6.6 1.1 1.5 2 2.6 2.6.2.1.4.2.6 0l.9-1.1c.2-.2.4-.3.7-.2l2.1 1c.3.1.4.3.4.5 0 .3-.2 1.4-.9 2-.6.6-1.5.9-2.5.6-1.2-.3-2.8-1-4.6-2.6-1.5-1.4-2.5-3.1-2.8-4.3-.3-1 0-2 .4-2.6Z" />
          </svg>
          {locale === "ar" ? "واتساب" : "WhatsApp"}
        </a>
      ) : null}
      <nav
        aria-label={locale === "ar" ? "إجراءات سريعة" : "Quick actions"}
        className="company-site__mobile-actions"
      >
        {settings?.functions?.trackingEnabled !== false ? (
          <a href="#tracking">{locale === "ar" ? "تتبع" : "Track"}</a>
        ) : null}
        {settings?.functions?.requestDeliveryEnabled !== false ? (
          <a href="#request-delivery">{locale === "ar" ? "اطلب توصيلاً" : "Request"}</a>
        ) : null}
        {whatsappUrl ? (
          <a href={whatsappUrl} rel="noreferrer" target="_blank">
            {locale === "ar" ? "واتساب" : "WhatsApp"}
          </a>
        ) : phone ? (
          <a href={`tel:${phone.replace(/[^+\d]/gu, "")}`}>{locale === "ar" ? "اتصل" : "Call"}</a>
        ) : null}
      </nav>
      <span className="version-badge company-site__version">{__APP_VERSION__}</span>
    </>
  );
}

export function CompanyWebsiteDraftPreviewReceiver(): ReactNode {
  const [payload, setPayload] = useState<PublicWebsitePayload>();
  const [, rerender] = useState(0);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (!isAllowedCompanyWebsitePreviewParent(event.origin)) return;
      if (!event.data || typeof event.data !== "object") return;
      const envelope = event.data as { type?: string; payload?: PublicWebsitePayload };
      if (envelope.type === "tawseelhub:company-website-draft-preview" && envelope.payload)
        setPayload(envelope.payload);
    };
    globalThis.addEventListener("message", receive);
    return () => globalThis.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    const keepInsidePreview = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      const href = target.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      const destination = new URL(href, globalThis.location.origin);
      const language = destination.searchParams.get("lang");
      if (language === "en" || language === "ar") {
        const current = new URL(globalThis.location.href);
        current.searchParams.set("websiteDraftPreview", "1");
        current.searchParams.set("lang", language);
        globalThis.history.replaceState({}, "", current);
        rerender((value) => value + 1);
      }
      const sectionId =
        destination.hash.slice(1) ||
        (destination.pathname.startsWith("/track")
          ? "tracking"
          : destination.pathname.startsWith("/request-delivery")
            ? "request-delivery"
            : destination.pathname.startsWith("/contact")
              ? "contact"
              : "");
      if (sectionId)
        document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    document.addEventListener("click", keepInsidePreview);
    return () => document.removeEventListener("click", keepInsidePreview);
  }, []);
  return payload ? (
    <PublicCompanyWebsite previewPayload={payload} />
  ) : (
    <main className="company-site company-site--loading">Preparing exact draft preview…</main>
  );
}

const copy = {
  en: {
    track: "Real-Time Tracking",
    trackingHelp: "Enter your secure tracking reference or Dana order number.",
    token: "Shipment reference",
    trackAction: "Track",
    trackingLoading: "Checking shipment status…",
    request: "Request delivery",
    name: "Contact name",
    mobile: "Mobile",
    email: "Email (optional)",
    pickupEmirate: "Pickup Emirate",
    pickup: "Pickup area / location",
    deliveryEmirate: "Delivery Emirate",
    delivery: "Delivery area / location",
    package: "Package description",
    quantity: "Quantity",
    weight: "Approx. weight (kg)",
    cod: "Cash on delivery",
    codAmount: "COD amount",
    date: "Requested date/time",
    notes: "Notes",
    submit: "Send request",
    received: "Your request has been received. The delivery company will confirm pricing.",
    notFound: "We couldn't find a shipment matching that reference.",
    lastUpdate: "Last updated",
    deliveredAt: "Delivered at",
    reference: "Shipment",
    status: "Current Status",
    timeline: "Shipment progress",
    company: "Delivery Company",
    whatsapp: "Continue on WhatsApp",
  },
  ar: {
    track: "تتبع الشحنة مباشرة",
    trackingHelp: "أدخل مرجع التتبع الآمن أو رقم طلب دانا.",
    token: "رقم تتبع الشحنة",
    trackAction: "تتبع",
    trackingLoading: "جارٍ التحقق من حالة الشحنة…",
    request: "اطلب توصيلاً",
    name: "اسم جهة الاتصال",
    mobile: "رقم الهاتف",
    email: "البريد الإلكتروني (اختياري)",
    pickupEmirate: "إمارة الاستلام",
    pickup: "منطقة / موقع الاستلام",
    deliveryEmirate: "إمارة التسليم",
    delivery: "منطقة / موقع التسليم",
    package: "وصف الطرد",
    quantity: "الكمية",
    weight: "الوزن التقريبي (كجم)",
    cod: "الدفع عند الاستلام",
    codAmount: "مبلغ التحصيل",
    date: "التاريخ / الوقت المطلوب",
    notes: "ملاحظات",
    submit: "إرسال الطلب",
    received: "تم استلام طلبك. ستقوم شركة التوصيل بتأكيد السعر.",
    notFound: "لم نتمكن من العثور على شحنة تطابق هذا المرجع.",
    lastUpdate: "آخر تحديث",
    deliveredAt: "وقت التسليم",
    reference: "الشحنة",
    status: "الحالة الحالية",
    timeline: "مراحل الشحنة",
    company: "شركة التوصيل",
    whatsapp: "المتابعة عبر واتساب",
  },
} as const;
const statusCopy: Record<string, { en: string; ar: string }> = {
  order_received: { en: "Order Received", ar: "تم استلام الطلب" },
  preparing: { en: "Preparing for Delivery", ar: "قيد التجهيز للتسليم" },
  assigned: { en: "Assigned for Delivery", ar: "تم تعيين مندوب للتسليم" },
  out_for_delivery: { en: "Out for Delivery", ar: "خرج للتسليم" },
  delivered: { en: "Delivered", ar: "تم التسليم" },
  returned: { en: "Returned", ar: "مرتجع" },
  cancelled: { en: "Cancelled", ar: "ملغي" },
};

interface PublicTrackingResult {
  reference: string;
  status: string;
  deliveredAt: string | null;
  lastUpdatedAt: string;
  company: { nameEn: string; nameAr: string | null };
  timeline: Array<{ status: string; occurredAt: string }>;
}

function TrackingSection({
  locale,
  override,
  preview,
}: {
  locale: "en" | "ar";
  override: string | undefined;
  preview: boolean;
}): ReactNode {
  const t = copy[locale];
  const [tracking, setTracking] = useState<PublicTrackingResult | null>();
  const [busy, setBusy] = useState(false);
  const track = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setTracking(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const trackingToken = String(data.get("trackingToken") ?? "").trim();
      if (preview) {
        setTracking(
          await previewBridge<PublicTrackingResult>("tawseelhub:preview-tracking-request", {
            trackingToken,
          }),
        );
      } else {
        const response = await fetch(`${apiBase()}/public/company-website/track`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(override ? { "x-blueline-tenant-host": override } : {}),
          },
          body: JSON.stringify({ trackingToken }),
        });
        if (!response.ok) throw new Error("tracking_not_found");
        setTracking((await response.json()) as PublicTrackingResult);
      }
    } catch {
      setTracking(null);
    } finally {
      setBusy(false);
    }
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(locale === "ar" ? "ar-AE" : "en-AE");
  return (
    <section
      className="company-site-function company-site-tracking"
      id="tracking"
      aria-labelledby="tracking-heading"
    >
      <div className="company-site-tracking__intro">
        <p className="site-template__kicker">{t.track}</p>
        <h2 id="tracking-heading">{t.track}</h2>
        <p>{t.trackingHelp}</p>
      </div>
      <form aria-busy={busy} onSubmit={(event) => void track(event)}>
        <label>
          {t.token}
          <input
            aria-describedby="tracking-format"
            autoCapitalize="none"
            autoComplete="off"
            maxLength={64}
            name="trackingToken"
            required
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? t.trackingLoading : t.trackAction}
        </button>
        <span className="company-site-tracking__hint" id="tracking-format">
          {locale === "ar"
            ? "يتم البحث داخل طلبات هذه الشركة فقط. لا نعرض أي بيانات شخصية."
            : "Only this company's orders are searched. No personal details are displayed."}
        </span>
      </form>
      <div aria-live="polite" aria-atomic="true">
        {busy ? (
          <p role="status">{t.trackingLoading}</p>
        ) : tracking === null ? (
          <p role="alert">{t.notFound}</p>
        ) : tracking ? (
          <article className="tracking-result">
            <p>
              <strong>{t.reference}:</strong> {tracking.reference}
            </p>
            <h3>
              {t.status}: {statusCopy[tracking.status]?.[locale] ?? statusCopy.preparing![locale]}
            </h3>
            <p>
              <strong>{t.company}:</strong>{" "}
              {locale === "ar"
                ? (tracking.company.nameAr ?? tracking.company.nameEn)
                : tracking.company.nameEn}
            </p>
            {tracking.timeline.length ? (
              <div className="tracking-timeline">
                <h4>{t.timeline}</h4>
                <ol>
                  {tracking.timeline.map((event, index) => (
                    <li key={`${event.status}-${event.occurredAt}-${index}`}>
                      <strong>
                        {statusCopy[event.status]?.[locale] ?? statusCopy.preparing![locale]}
                      </strong>
                      <time dateTime={event.occurredAt}>{date(event.occurredAt)}</time>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {tracking.deliveredAt ? (
              <p>
                <strong>{t.deliveredAt}:</strong> {date(tracking.deliveredAt)}
              </p>
            ) : null}
            <p>
              <strong>{t.lastUpdate}:</strong> {date(tracking.lastUpdatedAt)}
            </p>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function PublicFunctions({
  locale,
  override,
  settings,
  whatsappUrl,
}: {
  locale: "en" | "ar";
  override: string | undefined;
  settings: WebsiteSettings | undefined;
  whatsappUrl: string | null;
}): ReactNode {
  const t = copy[locale];
  const headers = {
    "Content-Type": "application/json",
    ...(override ? { "x-blueline-tenant-host": override } : {}),
  };
  const [request, setRequest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const section = (key: string) => settings?.sections.find((x) => x.key === key)?.enabled !== false;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(`${apiBase()}/public/company-website/delivery-requests`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...data,
          quantity: Number(data.quantity),
          approximateWeightKg: Number(data.approximateWeightKg),
          codRequired: data.codRequired === "on",
          codAmount: data.codRequired === "on" ? Number(data.codAmount || 0) : 0,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      if (!response.ok) throw new Error();
      const result = (await response.json()) as { reference: string };
      setRequest(result.reference);
    } catch {
      setRequest("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="company-site-functions" dir={locale === "ar" ? "rtl" : "ltr"}>
      {settings?.functions?.requestDeliveryEnabled !== false && section("request_delivery") ? (
        <section id="request-delivery" className="company-site-function">
          <h2>{t.request}</h2>
          {request !== undefined ? (
            <div aria-live="polite">
              <p>{request ? t.received : t.notFound}</p>
              {request ? (
                <p>
                  <strong>
                    {t.reference}: {request}
                  </strong>
                </p>
              ) : null}
              {request && whatsappUrl ? (
                <a
                  href={`${whatsappUrl}${whatsappUrl.includes("?") ? "&" : "?"}text=${encodeURIComponent(`${t.reference}: ${request}`)}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t.whatsapp}
                </a>
              ) : null}
            </div>
          ) : (
            <form className="delivery-request-form" onSubmit={(e) => void submit(e)}>
              {(
                [
                  ["contactName", t.name],
                  ["mobile", t.mobile],
                  ["email", t.email],
                  ["pickupEmirate", t.pickupEmirate],
                  ["pickupLocation", t.pickup],
                  ["deliveryEmirate", t.deliveryEmirate],
                  ["deliveryLocation", t.delivery],
                  ["packageDescription", t.package],
                  ["quantity", t.quantity],
                  ["approximateWeightKg", t.weight],
                ] as const
              ).map(([name, label]) => (
                <label key={name}>
                  {label}
                  <input
                    name={name}
                    required={name !== "email"}
                    type={
                      name === "email"
                        ? "email"
                        : name === "quantity" || name === "approximateWeightKg"
                          ? "number"
                          : "text"
                    }
                    {...(name === "quantity"
                      ? { min: 1, max: 100, defaultValue: 1 }
                      : name === "approximateWeightKg"
                        ? { min: 0.01, step: 0.01 }
                        : {})}
                  />
                </label>
              ))}
              <label>
                <input name="codRequired" type="checkbox" /> {t.cod}
              </label>
              <label>
                {t.codAmount}
                <input min="0" name="codAmount" step="0.01" type="number" />
              </label>
              <label>
                {t.date}
                <input name="requestedAt" type="datetime-local" />
              </label>
              <label className="delivery-request-form__wide">
                {t.notes}
                <textarea maxLength={1000} name="notes" />
              </label>
              <button disabled={busy} type="submit">
                {t.submit}
              </button>
            </form>
          )}
        </section>
      ) : null}
    </main>
  );
}

function Unavailable(): ReactNode {
  return (
    <main className="company-site company-site--unavailable">
      <h1>This website is currently unavailable.</h1>
      <p>Please check again later.</p>
    </main>
  );
}

export class CompanyWebsiteErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  public override state = { failed: false };
  public static getDerivedStateFromError() {
    return { failed: true };
  }
  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    void fetch(`${apiBase()}/errors/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceApp: "web",
        message: error.message,
        stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
        path: location.pathname,
        appCommit: __APP_VERSION__,
      }),
    }).catch(() => undefined);
  }
  public override render(): ReactNode {
    return this.state.failed ? <Unavailable /> : this.props.children;
  }
}
