import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { applyPageMetadata } from "./seo";
import { DeliveryCompanyPage } from "./DeliveryCompanyPage";
import { DemoRequestPage } from "./DemoRequestPage";
import { TraderPage } from "./TraderPage";
import { TraderRegistrationPage } from "./TraderRegistrationPage";
import { CustomerQuoteFlow, CustomerQuoteResult } from "./CustomerQuoteFlow";
import { BlogArticlePage, blogListingPreloadKey, BlogListingPage } from "./BlogPages";
import { PrivacyPolicyPage, TermsOfServicePage } from "./LegalPages";
import { getPreloaded, PreloadContext } from "./preload-context";
import { AgentChat } from "./AgentChat";
import {
  buildWhatsAppMessageUrl,
  getWhatsAppSettings,
  type WhatsAppPublicSettings,
} from "./agent-client";
import {
  pricingGapNote,
  pricingPlans,
  pricingProductAreas,
  pricingWebsiteAddOnNote,
} from "./pricing";
import { homeFaqs } from "./home-faq";
import { TrackingPage, TrackingWidget } from "./TrackingWidget";
import { trackEvent } from "./analytics";
import {
  loadWebsiteCms,
  phoneHref,
  type Locale,
  type WebsiteCmsBundle,
} from "./website-cms-client";
import {
  helpArticlePreloadKey,
  helpHomePreloadKey,
  loadHelpArticle,
  loadHelpHome,
  searchHelp,
  type HelpArticleBlock,
  type HelpArticleSummary,
} from "./help-center-client";
import {
  countriesByLocale,
  getStoredPublicLocale,
  navItemsByLocale,
  publicUi,
  routeMetadata,
  savePublicLocale,
} from "./public-localization";
import { apiUrl } from "./api-base";
import { DemoRequestError, submitDemoRequest } from "./demo-request-client";

export const routeDefinitions = Object.entries(routeMetadata.en).map(([path, metadata]) => ({
  path,
  ...metadata,
})) as Array<{ path: string; title: string; description: string }>;

export function isDynamicContentRoute(pathname: string): boolean {
  return pathname.startsWith("/blog/") || /^\/resources\/[^/]+\/?$/.test(pathname);
}

const CmsContext = createContext<{
  cms: WebsiteCmsBundle | null;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}>({ cms: null, locale: "en", setLocale: () => undefined });
const useCms = () => useContext(CmsContext);

const capabilities = [
  [
    "01",
    "Order Management",
    "Capture, organize and follow every delivery order from one clear workspace.",
  ],
  [
    "02",
    "Driver Operations",
    "Assign work, support drivers and keep delivery progress visible throughout the day.",
  ],
  [
    "03",
    "COD & Collections",
    "Bring cash-on-delivery handovers and collections into a controlled workflow.",
  ],
  [
    "04",
    "Trader Settlements",
    "Prepare and track Trader payables with consistent records and clear status.",
  ],
  [
    "05",
    "Accounting",
    "Connect daily delivery activity with the financial picture of your business.",
  ],
  [
    "06",
    "Payroll",
    "Manage employee payroll and delivery-related earnings in the same operating environment.",
  ],
  [
    "07",
    "Reports & Analytics",
    "Turn operational records into practical views for faster management decisions.",
  ],
  [
    "08",
    "Mobile Operations",
    "Keep field teams connected to the work that matters while they are moving.",
  ],
  [
    "09",
    "Trader Management",
    "Organize Trader relationships, service expectations and operational activity.",
  ],
  [
    "10",
    "Commerce Integrations",
    "Prepare connected order intake from the sales channels your Traders already use.",
  ],
] as const;
const capabilitiesAr = [
  ["01", "إدارة الطلبات", "تنظيم ومتابعة طلبات التوصيل من مساحة عمل واضحة."],
  ["02", "عمليات السائقين", "إسناد العمل ومتابعة تقدم التوصيل خلال اليوم."],
  ["03", "التحصيل والدفع عند الاستلام", "إدارة تسليمات وتحصيلات الدفع عند الاستلام بطريقة منظمة."],
  ["04", "تسويات التجار", "تجهيز ومتابعة مستحقات التجار بسجلات واضحة."],
  ["05", "المحاسبة", "ربط نشاط التوصيل اليومي بالصورة المالية للشركة."],
  ["06", "الرواتب", "إدارة رواتب الموظفين واستحقاقات التوصيل من نفس النظام."],
  ["07", "التقارير والتحليلات", "تحويل سجلات التشغيل إلى تقارير عملية لاتخاذ قرارات أسرع."],
  ["08", "عمليات الميدان", "إبقاء فرق العمل الميدانية متصلة بالمهام المهمة أثناء الحركة."],
  ["09", "إدارة التجار", "تنظيم علاقات التجار وتوقعات الخدمة والنشاط التشغيلي."],
  ["10", "تكاملات التجارة", "تجهيز استقبال الطلبات من قنوات البيع التي يستخدمها التجار."],
] as const;

const trackCta = (input: {
  ctaId: string;
  page?: string;
  destinationType?: "internal" | "whatsapp" | "phone" | "email" | "external";
  audience?: string;
  locale?: Locale;
  ctaLocation?: string;
}) =>
  trackEvent("cta_clicked", {
    page: input.page ?? window.location.pathname,
    cta_id: input.ctaId,
    destination_type: input.destinationType ?? "internal",
    audience: input.audience,
    locale: input.locale,
    cta_location: input.ctaLocation,
  });

function AppLayout() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [locale, setLocaleState] = useState<Locale>(() => getStoredPublicLocale());
  const [cms, setCms] = useState<WebsiteCmsBundle | null>(null);
  const route =
    routeDefinitions.find((item) => item.path === location.pathname) ?? routeDefinitions[0]!;
  const routeSeo = routeMetadata[locale][location.pathname] ?? routeMetadata[locale]["/"]!;
  const copy = publicUi[locale];
  const activeCms = cms?.locale === locale ? cms : null;
  const cmsNav = activeCms?.navigation?.length
    ? activeCms.navigation
        .filter((item) => item.visible)
        .map((item) => [item.destination, item.label] as const)
    : navItemsByLocale[locale];
  // Track Shipment is a required navigation entry regardless of CMS-configured
  // navigation content -- a Website admin's saved nav list predates this
  // feature and must not be able to silently drop it.
  const nav = cmsNav.some(([href]) => href === "/track")
    ? cmsNav
    : [...cmsNav, ["/track", copy.trackingNavLabel] as const];
  const homeSeo = activeCms?.pages.find((item) => item.pageKey === "home")?.content?.seo;
  const setLocale = (next: Locale) => {
    savePublicLocale(next);
    setCms(null);
    setLocaleState(next);
  };
  useEffect(() => {
    let cancelled = false;
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    setCms(null);
    void loadWebsiteCms(locale).then((next) => {
      if (!cancelled) setCms(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);
  useEffect(() => {
    if (!isDynamicContentRoute(location.pathname)) {
      applyPageMetadata(
        location.pathname === "/" && homeSeo?.title ? homeSeo.title : routeSeo.title,
        location.pathname === "/" && homeSeo?.description
          ? homeSeo.description
          : routeSeo.description,
        location.pathname === "/" && homeSeo?.canonical ? homeSeo.canonical : route.path,
        location.pathname === "/" && homeSeo
          ? {
              robots: `${homeSeo.robotsIndex === false ? "noindex" : "index"},${homeSeo.robotsFollow === false ? "nofollow" : "follow"}`,
            }
          : {},
      );
    }
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [route, location.pathname, homeSeo]);
  return (
    <CmsContext.Provider value={{ cms: activeCms, locale, setLocale }}>
      <div className="site-shell" dir={locale === "ar" ? "rtl" : "ltr"}>
        <a className="skip-link" href="#main-content">
          {copy.skipToContent}
        </a>
        <header className="site-header">
          <Link className="brand" to="/" aria-label="Tawseelhub home">
            <img src="/tawseelhub-logo-web.png" alt="Tawseelhub" />
          </Link>
          <nav className="desktop-nav" aria-label={copy.mainNavigation}>
            {nav.map(([href, label]) => (
              <NavLink key={href} to={href}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="header-actions">
            <button
              className="language"
              type="button"
              aria-label={`Switch language to ${copy.languageToggle}`}
              onClick={() => setLocale(locale === "en" ? "ar" : "en")}
            >
              {copy.languageToggle}
            </button>
            <Link
              className="button button-primary desktop-cta"
              to="/request-demo"
              onClick={() =>
                trackCta({
                  ctaId: "header_request_demo",
                  audience: "delivery_company",
                  locale,
                  ctaLocation: "header",
                })
              }
            >
              {copy.requestDemo}
            </Link>
            <button
              className="menu-button"
              type="button"
              aria-label={copy.openNavigation}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span />
              <span />
            </button>
          </div>
          {menuOpen && (
            <nav className="mobile-nav" aria-label={copy.mobileNavigation}>
              {nav.map(([href, label]) => (
                <NavLink key={href} to={href}>
                  {label}
                  <span>→</span>
                </NavLink>
              ))}
              <NavLink to="/request-demo">
                {copy.requestDemo} <span>→</span>
              </NavLink>
              <button type="button" onClick={() => setLocale(locale === "en" ? "ar" : "en")}>
                {copy.mobileLanguage}
              </button>
            </nav>
          )}
        </header>
        <main id="main-content">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/delivery-companies" element={<DeliveryCompanyPage />} />
            <Route path="/send-a-package" element={<SendPackagePage />} />
            <Route path="/send-a-package/quote/:reference" element={<CustomerQuoteResult />} />
            <Route path="/track" element={<TrackingPage />} />
            <Route path="/traders" element={<TraderPage />} />
            <Route path="/traders/register" element={<TraderRegistrationPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/resources/:slug" element={<HelpArticlePage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/blog" element={<BlogListingPage />} />
            <Route path="/blog/category/:categorySlug" element={<BlogListingPage />} />
            <Route path="/blog/:slug" element={<BlogArticlePage />} />
            <Route path="/faq" element={<FaqPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsOfServicePage />} />
            <Route path="/request-demo" element={<DemoRequestPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
        <AgentChat />
        <div className="version-badge" aria-label={`Build ${__APP_VERSION__}`}>
          v{__APP_VERSION__}
        </div>
      </div>
    </CmsContext.Provider>
  );
}

export function App() {
  return <AppLayout />;
}

function HomePage() {
  const { cms, locale } = useCms(),
    home = cms?.pages.find((item) => item.pageKey === "home")?.content,
    hero = home?.hero,
    copy = publicUi[locale],
    fallback =
      locale === "ar"
        ? {
            eyebrow: "مصمم لشركات التوصيل في الإمارات",
            heading: "نظام تشغيل التوصيل لشركات التوصيل الحديثة",
            subheading:
              "إدارة الطلبات والسائقين والتحصيل عند الاستلام وتسويات التجار والتقارير من منصة واحدة.",
            secondary: "أرسل شحنة",
            trust: ["جاهز للإمارات", "العربية والإنجليزية", "تحكم تشغيلي كامل"],
          }
        : {
            eyebrow: "Built for Delivery Businesses in the UAE",
            heading: "The Delivery Operating System for Modern Delivery Companies",
            subheading:
              "Manage orders, drivers, COD collections, Trader settlements, accounting, payroll and connected sales channels from one platform — while growing your delivery business through new Traders and customer delivery requests.",
            secondary: "Send a Package",
            trust: ["UAE-ready", "Arabic & English", "End-to-end control"],
          };
  useEffect(() => {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.dataset.homeSchema = "true";
    script.text = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          name: "Tawseelhub",
          url: "https://tawseelhub.com",
          logo: "https://tawseelhub.com/tawseelhub-logo.png",
        },
        { "@type": "WebSite", name: "Tawseelhub", url: "https://tawseelhub.com" },
        {
          "@type": "SoftwareApplication",
          name: "Tawseelhub",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          description:
            "Delivery management software for UAE delivery companies — courier management, last mile delivery, COD reconciliation, driver management, trader settlements, accounting and payroll in one delivery operating system.",
        },
      ],
    });
    document.head.append(script);
    return () => script.remove();
  }, []);
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span /> {hero?.eyebrow ?? fallback.eyebrow}
          </p>
          <h1>{hero?.heading ?? fallback.heading}</h1>
          <p className="hero-lede">{hero?.subheading ?? fallback.subheading}</p>
          <div className="hero-actions">
            <Link className="button button-primary" to={hero?.primaryCtaUrl ?? "/request-demo"}>
              {hero?.primaryCtaLabel ?? copy.requestDemo}
            </Link>
            <Link
              className="button button-secondary"
              to={hero?.secondaryCtaUrl ?? "/send-a-package"}
            >
              {hero?.secondaryCtaLabel ?? fallback.secondary} <span>→</span>
            </Link>
          </div>
          <div
            className="trust-row"
            aria-label={locale === "ar" ? "ميزات المنصة" : "Platform qualities"}
          >
            {fallback.trust.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>
        <OperationsVisual />
      </section>
      <QuoteModule compact />
      <TrackingHomepageSection />
      <ProofStrip />
      <CapabilitiesSection />
      <PricingPreview />
      <GrowthSection />
      <TraderSection />
      <SendPackageSection />
      <IntegrationsSection />
      <ResourcesSection />
      <HomeFaqSection />
      <FinalCta />
    </>
  );
}

function HomeFaqSection() {
  const { locale } = useCms();
  const copy =
    locale === "ar"
      ? {
          eyebrow: "الأسئلة الشائعة",
          title: "أسئلة شائعة عن Tawseelhub",
          intro:
            "كل ما تحتاج معرفته عن برنامج إدارة التوصيل في الإمارات — من إدارة السائقين ومطابقة الدفع عند الاستلام إلى تسويات التجار والرواتب.",
        }
      : {
          eyebrow: "FAQs",
          title: "Frequently Asked Questions",
          intro:
            "Everything you need to know about Tawseelhub — delivery management software for the UAE, from courier management and last mile delivery software in Dubai to COD reconciliation software and a delivery driver management app for your fleet.",
        };
  useEffect(() => {
    // FAQPage structured data so these answers are eligible for rich results.
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.dataset.homeFaqSchema = "true";
    script.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: homeFaqs.map((faq) => ({
        "@type": "Question",
        name: faq.q.en,
        acceptedAnswer: { "@type": "Answer", text: faq.a.en },
      })),
    });
    document.head.append(script);
    return () => script.remove();
  }, []);
  return (
    <section className="section home-faq-section">
      <div className="section-heading">
        <p className="eyebrow">
          <span />
          {copy.eyebrow}
        </p>
        <h2>{copy.title}</h2>
        <p>{copy.intro}</p>
      </div>
      <div className="home-faq-list">
        {homeFaqs.map((faq) => (
          <details key={faq.q.en}>
            <summary>{faq.q[locale]}</summary>
            <p>{faq.a[locale]}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function TrackingHomepageSection() {
  const { locale } = useCms(),
    copy = publicUi[locale];
  return (
    <section className="tracking-homepage-section" aria-labelledby="tracking-homepage-title">
      <div className="tracking-homepage-heading">
        <p className="eyebrow">
          <span />
          {copy.trackingHomepageEyebrow}
        </p>
        <h2 id="tracking-homepage-title">{copy.trackingHomepageTitle}</h2>
        <p>{copy.trackingHomepageCopy}</p>
      </div>
      <TrackingWidget compact />
    </section>
  );
}

function OperationsVisual() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            label:
              "رسم يوضح نظام تشغيل التوصيل يربط الطلبات والسائقين والتحصيل والتسويات والمحاسبة والتقارير",
            network: "نظام التشغيل",
            status: "● العمليات متصلة",
            country: "نظام تشغيل واحد",
            operation: "يربط كل عملية توصيل",
            nodes: [
              ["Orders", "الطلبات"],
              ["Drivers", "السائقين"],
              ["COD", "التحصيل"],
              ["Settlements", "التسويات"],
              ["Accounting", "المحاسبة"],
              ["Reports", "التقارير"],
            ],
            stats: [
              ["مسار الطلبات", "منظم"],
              ["التحصيل", "محكوم"],
              ["الفرق", "مترابطة"],
            ],
          }
        : {
            label:
              "Illustration of one delivery operating system connecting Orders, Drivers, COD, Settlements, Accounting and Reports",
            network: "Delivery operating system",
            status: "● Operations connected",
            country: "ONE SYSTEM",
            operation: "Your entire delivery operation",
            nodes: [
              ["Orders", "Orders"],
              ["Drivers", "Drivers"],
              ["COD", "COD"],
              ["Settlements", "Settlements"],
              ["Accounting", "Accounting"],
              ["Reports", "Reports"],
            ],
            stats: [
              ["Order flow", "Organized"],
              ["Collections", "Controlled"],
              ["Teams", "Connected"],
            ],
          };
  return (
    <div className="operations-visual" aria-label={copy.label}>
      <div className="visual-topline">
        <span>{copy.network}</span>
        <span className="status">{copy.status}</span>
      </div>
      <div className="uae-label">
        <span>{copy.country}</span>
        <b>{copy.operation}</b>
      </div>
      <div className="domain-grid">
        {copy.nodes.map(([key, label]) => (
          <div key={key} className={`domain-node domain-${(key ?? "").toLowerCase()}`}>
            <b>{key}</b>
            <small>{label}</small>
          </div>
        ))}
      </div>
      <div className="visual-stats">
        {copy.stats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuoteModule({ compact = false }: { compact?: boolean }) {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "أرسل شحنة",
            title: "هل تريد إرسال شحنة؟",
            intro: "استخدم نموذج Tawseelhub واحداً لطلبات التوصيل داخل الإمارات وخارجها.",
            cardTitle: "احصل على عرض توصيل",
            cardCopy:
              "أدخل بيانات التواصل والاستلام والتوصيل والشحنة مرة واحدة. يمكن لمسارات الإمارات المعتمدة إظهار سعر فوري، أما المسارات الدولية أو غير المعتادة فتُسجل للمراجعة اليدوية.",
            cta: "احصل على عرض توصيل",
            you: "أنت",
            assistant: "المساعد",
            sampleUser: "أريد إرسال شحنة.",
            sampleAssistant: "أكيد. ابدأ ببيانات التواصل، ثم أضف مسار الشحنة وتفاصيلها.",
          }
        : {
            eyebrow: "Send a Package",
            title: "Need to send a package?",
            intro:
              "Use one simple Tawseelhub form for UAE domestic and international package delivery requests.",
            cardTitle: "Get a delivery quotation",
            cardCopy:
              "Enter pickup, destination, package and contact details once. UAE routes can show configured instant prices; international or unusual routes are captured for manual review.",
            cta: "Get Delivery Quote",
            you: "You",
            assistant: "Assistant",
            sampleUser: "I need to send a package.",
            sampleAssistant:
              "Sure. Start with your contact details, then add the package route and shipment details.",
          };
  return (
    <section
      className={`quote-wrap ${compact ? "quote-compact" : ""}`}
      aria-labelledby="quote-title"
    >
      <div className="quote-heading">
        <div>
          <span>{copy.eyebrow}</span>
          <strong id="quote-title">{copy.title}</strong>
        </div>
        <p>{copy.intro}</p>
      </div>
      <div className="quote-cta-card">
        <div>
          <h3>{copy.cardTitle}</h3>
          <p>{copy.cardCopy}</p>
        </div>
        <Link
          className="button button-primary"
          to="/send-a-package"
          onClick={() =>
            trackCta({
              ctaId: "quote_module_get_delivery_quote",
              audience: "customer",
              ctaLocation: "quote_module",
              locale,
            })
          }
        >
          {copy.cta} <span>→</span>
        </Link>
      </div>
      <div className="assistant-preview">
        <div className="assistant-mark">T</div>
        <div>
          <span>Yousef · Tawseelhub AI Assistant</span>
          <p>
            <b>{copy.you}:</b> “{copy.sampleUser}”
          </p>
          <p>
            <b>{copy.assistant}:</b> “{copy.sampleAssistant}”
          </p>
        </div>
      </div>
    </section>
  );
}

function ProofStrip() {
  const { locale } = useCms(),
    items =
      locale === "ar"
        ? [
            "مصمم لعمليات التوصيل في الإمارات",
            "بنية متعددة الشركات",
            "تحكم تشغيلي شامل",
            "جاهز بالعربية والإنجليزية",
          ]
        : [
            "Built for UAE delivery operations",
            "Multi-tenant architecture",
            "End-to-end operational control",
            "Arabic & English ready",
          ];
  return (
    <section
      className="proof-strip"
      aria-label={locale === "ar" ? "ميزات منصة Tawseelhub" : "Tawseelhub platform qualities"}
    >
      {items.map((item, index) => (
        <div key={item}>
          <span>0{index + 1}</span>
          {item}
        </div>
      ))}
    </section>
  );
}
function SectionHeading({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <div className="section-heading">
      <p className="eyebrow">
        <span />
        {eyebrow}
      </p>
      <h2>{title}</h2>
      <p>{copy}</p>
    </div>
  );
}
function CapabilitiesSection() {
  const { cms, locale } = useCms(),
    items = cms?.features?.length
      ? cms.features.map(
          (feature, index) =>
            [
              String(index + 1).padStart(2, "0"),
              feature.data.name,
              feature.data.shortDescription,
            ] as const,
        )
      : locale === "ar"
        ? capabilitiesAr
        : capabilities;
  return (
    <section className="section capabilities-section">
      <SectionHeading
        eyebrow={locale === "ar" ? "نظام التشغيل" : "The operating system"}
        title={
          locale === "ar"
            ? "منصة واحدة لعمليات التوصيل الكاملة."
            : "One Platform. Complete Delivery Operations."
        }
        copy={
          locale === "ar"
            ? "اجمع الأجزاء المتحركة في شركة التوصيل داخل طريقة عمل مترابطة وواضحة."
            : "Bring the moving parts of a modern delivery company into one connected, dependable way of working."
        }
      />
      <div className="capability-grid">
        {items.map(([number, title, copy]) => (
          <article key={title}>
            <span>{number}</span>
            <h3>{title}</h3>
            <p>{copy}</p>
            <i aria-hidden="true">↗</i>
          </article>
        ))}
      </div>
      <div className="center-action">
        <Link className="text-link" to="/delivery-companies">
          {locale === "ar" ? "استكشف مزايا شركات التوصيل" : "Explore Delivery Company Features"}{" "}
          <span>→</span>
        </Link>
      </div>
    </section>
  );
}
function GrowthSection() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "العمليات + الفرص",
            title: "أدر شركة التوصيل بالكامل من منصة واحدة",
            body: "أدر الطلبات والسائقين وتحصيل الدفع عند الاستلام وتسويات التجار والمحاسبة والرواتب من خلال نظام تشغيل توصيل واحد متصل، صُمم لتبسيط العمليات ودعم نمو أعمالك.",
            cta: "اطلب عرضاً",
            items: [
              ["فرص التجار", "استقبل فرصاً منظمة من أعمال تبحث عن دعم توصيل."],
              ["طلبات شحن العملاء", "تعامل مع طلبات الشحن الجديدة بدون عرض دليل شركات عام."],
              ["طلبات التجارة المتصلة", "استعد لتدفق الطلبات من قنوات البيع التي يستخدمها التجار."],
              ["إدخال منظم", "قلل الاعتماد على واتساب والجداول وإعادة الإدخال اليدوي."],
            ],
          }
        : {
            eyebrow: "Operations + opportunity",
            title: "Run Your Entire Delivery Business from One Platform",
            body: "Manage orders, drivers, COD collections, trader settlements, accounting and payroll with one connected delivery operating system designed to simplify operations and support business growth.",
            cta: "Request a Demo",
            items: [
              [
                "Trader opportunities",
                "Receive structured opportunities from businesses looking for delivery support.",
              ],
              [
                "Customer package requests",
                "Handle new package requests without exposing a public company directory.",
              ],
              [
                "Connected commerce orders",
                "Prepare for order flow from the online channels Traders already use.",
              ],
              [
                "Structured intake",
                "Reduce WhatsApp, spreadsheet and manual re-entry across your operation.",
              ],
            ],
          };
  return (
    <section className="split-section growth-section">
      <div className="section-heading">
        <p className="eyebrow light">
          <span />
          {copy.eyebrow}
        </p>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <Link className="button button-light" to="/request-demo">
          {copy.cta}
        </Link>
      </div>
      <div className="growth-list">
        {copy.items.map(([title, body], index) => (
          <article key={title}>
            <span>{index + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function TraderSection() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "للتجار",
            title: "قنوات البيع لديك متصلة مباشرة بالتوصيل.",
            body: "سجل نشاطك التجاري مع Tawseelhub وأنشئ مساراً أوضح من كل طلب إلى شركة التوصيل.",
            note: "تبيع حالياً عبر Salla أو Shopify أو WooCommerce؟ التكامل جاهز وبانتظار الاختبار الخارجي، وسيساعد على إرسال طلبات التوصيل تلقائياً إلى شركة التوصيل.",
            cta: "تسجيل تاجر",
            cards: [
              [
                "لديك شركة توصيل بالفعل",
                "يتحقق Tawseelhub من علاقة التاجر الحالية ويربطها حتى يصبح التعامل مع الطلبات أكثر تنظيماً.",
              ],
              [
                "تحتاج إلى شركة توصيل",
                "أرسل متطلباتك ويمكن لـ Tawseelhub المساعدة في الحصول على عروض توصيل مناسبة بدون دليل شركات عام.",
              ],
            ],
          }
        : {
            eyebrow: "For Traders",
            title: "Your sales channels, directly connected to delivery.",
            body: "Register your business with Tawseelhub and create a clearer path from each order to your Delivery Company.",
            note: "Already selling on Salla, Shopify or WooCommerce? Integration is ready and awaiting external testing, and will help send delivery orders automatically to your Delivery Company.",
            cta: "Register as a Trader",
            cards: [
              [
                "Already have a Delivery Company",
                "Tawseelhub verifies and connects the existing Trader relationship so order handling can become more structured.",
              ],
              [
                "Need a Delivery Company",
                "Submit your requirements and Tawseelhub can help obtain suitable delivery quotations without a public company directory.",
              ],
            ],
          };
  return (
    <section className="section trader-section">
      <div className="trader-intro">
        <SectionHeading eyebrow={copy.eyebrow} title={copy.title} copy={copy.body} />
        <p className="integration-note">{copy.note}</p>
        <Link className="button button-primary" to="/traders">
          {copy.cta}
        </Link>
      </div>
      <div className="scenario-grid">
        {copy.cards.map(([title, body], index) => (
          <article key={title}>
            <span>0{index + 1}</span>
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
function SendPackageSection() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "للمرسلين داخل الإمارات وخارجها",
            title: "أرسل شحنة محلياً أو دولياً",
            body: "أدخل بيانات الاستلام والوجهة والشحنة للحصول على خيار توصيل متاح أو متابعة عرض يدوي.",
            benefits: [
              "أسعار فورية لمسارات الإمارات المعتمدة",
              "طلبات عروض دولية",
              "الدفع عند الاستلام لمسارات الإمارات فقط",
              "عرض مخصص للشحنات غير المعتادة",
            ],
            cta: "احصل على عرض توصيل",
          }
        : {
            eyebrow: "For UAE and international senders",
            title: "Send a Package Locally or Internationally",
            body: "Enter your pickup, destination and package details to receive an available delivery option or a manual quotation follow-up.",
            benefits: [
              "Instant pricing for configured UAE routes",
              "International quotation requests",
              "COD for UAE domestic routes only",
              "Custom quotation for unusual shipments",
            ],
            cta: "Get a Delivery Quote",
          };
  return (
    <section className="package-banner">
      <div>
        <p className="eyebrow light">
          <span />
          {copy.eyebrow}
        </p>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <div className="benefit-pills">
          {copy.benefits.map((item) => (
            <span key={item}>✓ {item}</span>
          ))}
        </div>
      </div>
      <Link className="button button-light" to="/send-a-package">
        {copy.cta} <span>→</span>
      </Link>
    </section>
  );
}
function cmsPlans(_cms: WebsiteCmsBundle | null) {
  return pricingPlans.map((plan) => ({ ...plan, recommended: plan.name === "Growth" }));
}
function PricingPreview() {
  const { cms, locale } = useCms(),
    home = cms?.pages.find((item) => item.pageKey === "home")?.content,
    plans = cmsPlans(cms),
    copy = publicUi[locale];
  return (
    <section className="section pricing-preview">
      <SectionHeading
        eyebrow={copy.pricingEyebrow}
        title={
          home?.pricingPreview?.heading ??
          (locale === "ar"
            ? "أسعار واضحة بالدرهم مع نمو حجم التوصيل."
            : "Simple AED pricing as your delivery volume grows.")
        }
        copy={
          locale === "ar"
            ? "ابدأ مجاناً، ثم انتقل إلى خطة شهرية حسب حجم الطلبات. لأكثر من 10,000 طلب شهرياً، يؤكد فريق Tawseelhub الخطة التجارية المناسبة."
            : "Start free, then move into a monthly plan based on order volume. For more than 10,000 monthly orders, Tawseelhub can confirm a custom commercial tier."
        }
      />
      <div className="pricing-mini-grid">
        {plans.slice(0, 4).map((plan) => (
          <article key={plan.name}>
            <span>{plan.name}</span>
            <strong>{plan.price}</strong>
            <p>{locale === "ar" ? plan.volumeAr : plan.volume}</p>
          </article>
        ))}
      </div>
      <div className="center-action">
        <Link className="button button-secondary" to="/pricing">
          {copy.fullPricing}
        </Link>
      </div>
    </section>
  );
}
function PricingPage() {
  const { cms, locale } = useCms(),
    plans = cmsPlans(cms),
    copy = publicUi[locale];
  useEffect(() => {
    trackEvent("pricing_viewed", { page: "/pricing", locale });
  }, [locale]);
  return (
    <>
      <InnerHero
        eyebrow={copy.pricingEyebrow}
        title={copy.pricingTitle}
        copy={[copy.pricingCopy, copy.pricingIntro]}
        action={
          <Link
            className="button button-primary"
            to="/request-demo"
            onClick={() =>
              trackEvent("pricing_cta_clicked", {
                page: "/pricing",
                cta_type: "request_demo",
                locale,
              })
            }
          >
            {copy.requestDemo}
          </Link>
        }
      />
      <section className="section pricing-section">
        <div className="pricing-grid">
          {plans.map((plan) => {
            const note = locale === "ar" ? plan.noteAr : plan.note;
            return (
              <article
                className={`pricing-card ${plan.recommended ? "pricing-card--featured" : ""}`}
                key={plan.name}
              >
                <div>
                  <span>{plan.recommended ? copy.common : copy.pricingPlanBadge}</span>
                  <h2>{plan.name}</h2>
                  <strong>{plan.price}</strong>
                  <p>{locale === "ar" ? "شهرياً" : plan.period}</p>
                  <b>{locale === "ar" ? plan.volumeAr : plan.volume}</b>
                  {note ? <p className="pricing-card-note">{note}</p> : null}
                </div>
                <ul>
                  {(locale === "ar" ? plan.highlightsAr : plan.highlights).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <Link
                  className="button button-primary"
                  to={plan.href}
                  onClick={() =>
                    trackEvent("pricing_cta_clicked", {
                      page: "/pricing",
                      plan_name: plan.name,
                      cta_type: plan.cta,
                      locale,
                    })
                  }
                >
                  {locale === "ar" ? plan.ctaAr : plan.cta}
                </Link>
              </article>
            );
          })}
        </div>
        <p className="pricing-note">
          {locale === "ar"
            ? "لأكثر من 10,000 طلب شهرياً، يمكن لفريق Tawseelhub تأكيد خطة تجارية مخصصة."
            : pricingGapNote}
        </p>
        <p className="pricing-note">
          {locale === "ar"
            ? "* موقع الشركة الإلكتروني متاح مقابل تكلفة إضافية."
            : pricingWebsiteAddOnNote}
        </p>
      </section>
      <PricingCapabilitiesSection />
      <FinalCta />
    </>
  );
}
function PricingHierarchy() {
  const { locale } = useCms(),
    copy = publicUi[locale],
    system = pricingProductAreas[0]!,
    branches = pricingProductAreas.slice(1);
  return (
    <div
      className="pricing-hierarchy"
      aria-label={locale === "ar" ? "التسلسل الهرمي للمنتج" : "Product hierarchy"}
    >
      <span className="hierarchy-root">{copy.pricingHierarchyRoot}</span>
      <span className="hierarchy-arrow" aria-hidden="true">
        ↓
      </span>
      <span className="hierarchy-system">{locale === "ar" ? system.nameAr : system.name}</span>
      <div className="hierarchy-branches">
        {branches.map((area) => (
          <span key={area.key}>{locale === "ar" ? area.nameAr : area.name}</span>
        ))}
      </div>
    </div>
  );
}
function PricingCapabilitiesSection() {
  const { locale } = useCms(),
    copy = publicUi[locale];
  return (
    <section className="section pricing-capabilities">
      <SectionHeading
        eyebrow={copy.pricingCapabilitiesEyebrow}
        title={copy.pricingCapabilitiesTitle}
        copy={copy.pricingCapabilitiesCopy}
      />
      <div className="pricing-capabilities-grid">
        {pricingProductAreas.map((area) => (
          <article key={area.key}>
            <h3>{locale === "ar" ? area.nameAr : area.name}</h3>
            <ul>
              {(locale === "ar" ? area.itemsAr : area.items).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <p className="pricing-capabilities-note">{copy.companyWebsiteExplanation}</p>
      <PricingHierarchy />
    </section>
  );
}
function IntegrationsSection() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "تجارة متصلة",
            title: "اربط قنوات البيع التي يستخدمها التجار حالياً",
            body: "يحتفظ التجار بمتاجرهم الإلكترونية الحالية. Tawseelhub يجهز لربط طلباتهم مباشرة بعمليات شركة التوصيل.",
            status: "التكامل جاهز — بانتظار الاختبار الخارجي",
            cta: "استكشف التكاملات",
          }
        : {
            eyebrow: "Connected commerce",
            title: "Connect the Sales Channels Your Traders Already Use",
            body: "Traders keep their existing online stores. Tawseelhub is preparing to connect their orders directly to their Delivery Company.",
            status: "Integration Ready — External Test Pending",
            cta: "Explore Integrations",
          };
  return (
    <section className="section integrations-section">
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} copy={copy.body} />
      <div className="integration-grid">
        {["Salla", "Shopify", "WooCommerce"].map((name) => (
          <article key={name}>
            <span>{name.slice(0, 1)}</span>
            <h3>{name}</h3>
            <p>{copy.status}</p>
          </article>
        ))}
      </div>
      <Link className="text-link" to="/integrations">
        {copy.cta} <span>→</span>
      </Link>
    </section>
  );
}
export function ResourcesSection() {
  const { locale } = useCms();
  const preloadMap = useContext(PreloadContext);
  const [articles, setArticles] = useState<Array<{
    slug: string;
    title: string;
    excerpt: string;
    category: string;
  }> | null>(
    () =>
      getPreloaded<{
        items: Array<{ slug: string; title: string; excerpt: string; category: string }>;
      }>(preloadMap, blogListingPreloadKey(locale, 1))?.items.slice(0, 4) ?? null,
  );
  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl(`/public/blog?language=${locale}&page=1`))
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => {
        if (!cancelled) setArticles((data.items ?? []).slice(0, 4));
      })
      .catch(() => {
        if (!cancelled) setArticles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);
  const copy =
    locale === "ar"
      ? {
          eyebrow: "معرفة لقادة التوصيل",
          title: "رؤى وموارد",
          body: "أفكار عملية لبناء عمليات توصيل أقوى وعلاقات تجار أفضل وخدمة أكثر اعتماداً.",
          read: "اقرأ المقال",
          view: "عرض كل المقالات",
          emptyTitle: "المقالات قادمة قريباً",
          emptyBody:
            "يعمل فريق Tawseelhub على تجهيز أول دليل عملياتي. عد قريباً أو اطلع على مركز المساعدة في هذه الأثناء.",
          helpCta: "مركز المساعدة",
        }
      : {
          eyebrow: "Knowledge for delivery leaders",
          title: "Insights & Resources",
          body: "Practical thinking for building stronger delivery operations, better Trader relationships and more dependable service.",
          read: "Read article",
          view: "View All Articles",
          emptyTitle: "Articles are coming soon",
          emptyBody:
            "We're preparing the first Tawseelhub operations guides. Check back soon, or browse the Help Center in the meantime.",
          helpCta: "Visit Help Center",
        };
  if (articles === null) return null;
  return (
    <section className="section resources-section">
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} copy={copy.body} />
      {articles.length === 0 ? (
        <div className="empty-content">
          <h3>{copy.emptyTitle}</h3>
          <p>{copy.emptyBody}</p>
          <Link className="text-link" to="/resources">
            {copy.helpCta} <span>→</span>
          </Link>
        </div>
      ) : (
        <>
          <div className="article-grid">
            {articles.map((article, index) => (
              <article key={article.slug}>
                <div className={`article-art art-${(index % 4) + 1}`}>
                  <span>TAWSEELHUB / INSIGHTS</span>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                </div>
                <div className="article-body">
                  <span>{article.category}</span>
                  <h3>{article.title}</h3>
                  <p>{article.excerpt}</p>
                  <Link to={`/blog/${article.slug}`}>
                    {copy.read} <span>→</span>
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <div className="center-action">
            <Link className="button button-secondary" to="/blog">
              {copy.view}
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
function FinalCta() {
  const { cms, locale } = useCms(),
    home = cms?.pages.find((item) => item.pageKey === "home")?.content,
    cta = home?.requestDemoCta,
    copy = publicUi[locale],
    fallbackHeading =
      locale === "ar" ? "جاهز لربط عمليات التوصيل؟" : "Ready to connect your delivery operation?";
  return (
    <section className="final-cta">
      <p className="eyebrow light">
        <span />
        {locale === "ar" ? "مصمم لطريقة حركة التوصيل" : "Built for the way delivery moves"}
      </p>
      <h2>{cta?.heading ?? fallbackHeading}</h2>
      <p>
        {cta?.text ??
          (locale === "ar"
            ? "شاهد كيف يساعد Tawseelhub في تنظيم العمليات والتحكم المالي والنمو."
            : "See how Tawseelhub can bring daily operations, financial control and business growth into one platform.")}
      </p>
      <div>
        <Link className="button button-light" to="/request-demo">
          {cta?.buttonLabel ?? copy.requestDemo}
        </Link>
        <Link className="button button-ghost" to="/contact">
          {copy.talk}
        </Link>
      </div>
    </section>
  );
}

function InnerHero({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string | string[];
  action?: React.ReactNode;
}) {
  const lines = Array.isArray(copy) ? copy : [copy];
  return (
    <section className="inner-hero">
      <p className="eyebrow">
        <span />
        {eyebrow}
      </p>
      <h1>{title}</h1>
      {lines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
      {action && <div className="hero-actions">{action}</div>}
    </section>
  );
}
function SendPackagePage() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "أرسل شحنة",
            title: "أرسل شحنة محلياً أو دولياً",
            body: "استخدم نموذجاً واحداً لطلبات عروض الشحن داخل الإمارات، ومن الإمارات إلى الخارج، ومن الخارج إلى الإمارات، وبين الدول الأخرى.",
            benefitEyebrow: "مصمم لاحتياجات التوصيل الشائعة",
            benefitTitle: "خيارات واضحة بدون دليل شركات عام.",
            benefitCopy:
              "يمكن للمسارات المعتمدة داخل الإمارات إظهار أسعار فورية. أما المسارات الدولية أو غير المعتادة أو غير المسعرة فتُسجل لمتابعة عرض مخصص.",
            benefits: [
              "أسعار فورية لمسارات الإمارات المعتمدة",
              "تسجيل طلبات العروض الدولية",
              "الدفع عند الاستلام داخل الإمارات فقط",
              "عرض ضيف بدون حساب",
              "مراجعة مخصصة للشحنات غير المعتادة",
            ],
          }
        : {
            eyebrow: "Send a Package",
            title: "Send a Package Locally or Internationally",
            body: "Use one form for UAE domestic, UAE-to-international, international-to-UAE, and international-to-international package quotation requests.",
            benefitEyebrow: "Designed for common delivery needs",
            benefitTitle: "Clear options, without a company directory.",
            benefitCopy:
              "Configured UAE routes can show instant prices. International, unusual, or unpriced routes are recorded for custom quotation follow-up.",
            benefits: [
              "Instant pricing for configured UAE routes",
              "International quote capture",
              "COD for UAE domestic routes only",
              "Guest quote — no account needed",
              "Custom review for unusual shipments",
            ],
          };
  return (
    <>
      <InnerHero eyebrow={copy.eyebrow} title={copy.title} copy={copy.body} />
      <CustomerQuoteFlow />
      <section className="section simple-benefits">
        <SectionHeading
          eyebrow={copy.benefitEyebrow}
          title={copy.benefitTitle}
          copy={copy.benefitCopy}
        />
        <div className="capability-grid compact-grid">
          {copy.benefits.map((title, index) => (
            <article key={title}>
              <span>0{index + 1}</span>
              <h3>{title}</h3>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
function IntegrationsPage() {
  const { locale } = useCms(),
    copy =
      locale === "ar"
        ? {
            eyebrow: "التكاملات",
            title: "احتفظ بالمتجر الذي يستخدمه التجار حالياً.",
            body: "يهم ربط التجارة الإلكترونية شركات التوصيل والتجار لأن كل طلب يدخل بشكل يدوي هو فرصة للتأخير أو الخطأ أو الازدواج. تكامل Tawseelhub جاهز وينتظر الاختبار الخارجي، ويستقبل طلبات Salla وShopify وWooCommerce تلقائياً ويحولها إلى طلبات توصيل Tawseelhub الرسمية.",
            whyEyebrow: "لماذا يهم التكامل",
            whyTitle: "استمرارية تشغيلية بدون إعادة إدخال يدوي.",
            why: [
              [
                "استقبال الطلبات الخارجية",
                "يصل كل طلب من المتجر الإلكتروني مباشرة إلى نظام Tawseelhub بدلاً من نسخه يدوياً.",
              ],
              [
                "إنشاء طلب Tawseelhub الرسمي",
                "يتحول طلب المتجر إلى طلب توصيل رسمي بمعرّف واحد يتابعه الجميع.",
              ],
              [
                "مطابقة البيانات",
                "يتم ربط العميل والمنطقة وتفاصيل الشحنة تلقائياً بالحقول الصحيحة في Tawseelhub.",
              ],
              [
                "الحماية من التكرار",
                "لا يُنشأ طلب توصيل مكرر لنفس طلب المتجر حتى مع إعادة المزامنة.",
              ],
              [
                "استمرارية العمليات",
                "يستمر التوصيل والتحصيل والتسوية بشكل طبيعي بغض النظر عن مصدر الطلب.",
              ],
            ],
            flowEyebrow: "مسار التكامل",
            flowTitle: "من الطلب الإلكتروني إلى عملية التوصيل.",
            flowCopy: "اتجاه التكامل مبني على استقبال طلبات منظم، والتحقق، ووضوح المسؤولية.",
            steps: [
              "يستقبل التاجر طلباً إلكترونياً",
              "يجهز Tawseelhub طلب التوصيل",
              "تدير شركة التوصيل التنفيذ",
            ],
          }
        : {
            eyebrow: "Integrations",
            title: "Keep the store your Traders already use.",
            body: "Commerce integration matters for Delivery Companies and Traders because every order re-typed by hand is a chance for delay, error or duplication. Tawseelhub’s integration is ready and awaiting external testing: it ingests Salla, Shopify and WooCommerce orders automatically and turns each one into a canonical Tawseelhub delivery order.",
            whyEyebrow: "Why integration matters",
            whyTitle: "Operational continuity without manual re-entry.",
            why: [
              [
                "External order ingestion",
                "Every order placed on the Trader’s store reaches Tawseelhub directly, instead of being copied in by hand.",
              ],
              [
                "Canonical Tawseelhub order creation",
                "Each incoming store order becomes one official Tawseelhub delivery order with a single ID everyone tracks.",
              ],
              [
                "Field mapping",
                "Customer, area and shipment details from the store map automatically onto the correct Tawseelhub fields.",
              ],
              [
                "Duplicate protection",
                "The same store order can never create two delivery orders, even if the connection re-syncs.",
              ],
              [
                "Operational continuity",
                "Delivery, collection and settlement work the same way regardless of which channel the order came from.",
              ],
            ],
            flowEyebrow: "Integration flow",
            flowTitle: "From online order to delivery operation.",
            flowCopy:
              "The integration direction is built around structured order intake, validation and clear ownership.",
            steps: [
              "Trader receives an online order",
              "Tawseelhub prepares the delivery request",
              "Delivery Company manages fulfillment",
            ],
          };
  return (
    <>
      <InnerHero eyebrow={copy.eyebrow} title={copy.title} copy={copy.body} />
      <IntegrationsSection />
      <section className="section why-section">
        <div className="section-heading">
          <p className="eyebrow">
            <span />
            {copy.whyEyebrow}
          </p>
          <h2>{copy.whyTitle}</h2>
        </div>
        <div className="dc-group-grid">
          {copy.why.map(([title, body], index) => (
            <article key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="section process-section">
        <SectionHeading eyebrow={copy.flowEyebrow} title={copy.flowTitle} copy={copy.flowCopy} />
        <div className="process-flow">
          {copy.steps.map((item, index) => (
            <div key={item}>
              <span>0{index + 1}</span>
              <h3>{item}</h3>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
function ResourcesPage() {
  const { locale } = useCms();
  const preloadMap = useContext(PreloadContext);
  const preloadedHome = getPreloaded<{ categories: any[]; articles: HelpArticleSummary[] }>(
    preloadMap,
    helpHomePreloadKey(locale),
  );
  const [home, setHome] = useState<{ categories: any[]; articles: HelpArticleSummary[] } | null>(
    () => preloadedHome ?? null,
  );
  const [query, setQuery] = useState("");
  const [audience, setAudience] = useState("all");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<HelpArticleSummary[]>(() => preloadedHome?.articles ?? []);
  const [error, setError] = useState("");
  const isAr = locale === "ar";
  useEffect(() => {
    let cancelled = false;
    void loadHelpHome(locale)
      .then((data) => {
        if (!cancelled) {
          setHome(data);
          setResults(data.articles);
        }
      })
      .catch(() =>
        setError(isAr ? "تعذر تحميل مركز المساعدة." : "Help Center could not be loaded."),
      );
    return () => {
      cancelled = true;
    };
  }, [locale, isAr]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void searchHelp(locale, query, audience, category)
        .then((data) => setResults(data.results))
        .catch(() => setError(isAr ? "تعذر البحث الآن." : "Search is not available right now."));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [locale, query, audience, category, isAr]);
  return (
    <>
      <InnerHero
        eyebrow={isAr ? "مركز المساعدة" : "Help Center"}
        title={isAr ? "ابحث في أدلة Tawseelhub." : "Search guides, answers and resources."}
        copy={
          isAr
            ? "أدلة واضحة للطلبات والسائقين والتحصيل والتجار والتقارير والتكاملات."
            : "Find practical Tawseelhub guides for orders, drivers, COD collections, Trader statements, reports, integrations and support."
        }
      />
      <section className="section help-center">
        <div className="help-search">
          <label>
            {isAr ? "ابحث" : "Search"}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isAr ? "اكتب سؤالك" : "Type your question"}
            />
          </label>
          <label>
            {isAr ? "الفئة" : "Category"}
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{isAr ? "كل الفئات" : "All categories"}</option>
              {home?.categories.map((item: any) => (
                <option key={`${item.slug}-${item.locale}`} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {isAr ? "الجمهور" : "Audience"}
            <select value={audience} onChange={(e) => setAudience(e.target.value)}>
              <option value="all">{isAr ? "الكل" : "All"}</option>
              <option value="delivery_company">
                {isAr ? "شركات التوصيل" : "Delivery companies"}
              </option>
              <option value="trader">{isAr ? "التجار" : "Traders"}</option>
              <option value="customer">{isAr ? "العملاء" : "Customers"}</option>
              <option value="integration_developer">{isAr ? "التكاملات" : "Integrations"}</option>
            </select>
          </label>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <div className="help-layout">
          <aside className="help-categories">
            <h2>{isAr ? "الفئات" : "Categories"}</h2>
            {home?.categories.map((item: any) => (
              <button
                key={`${item.slug}-${item.locale}`}
                className={category === item.slug ? "active" : ""}
                onClick={() => setCategory(category === item.slug ? "" : item.slug)}
              >
                <strong>{item.name}</strong>
                <span>
                  {item.articleCount} {isAr ? "دليل" : "guides"}
                </span>
              </button>
            ))}
          </aside>
          <div className="help-results">
            <h2>
              {query
                ? isAr
                  ? "نتائج البحث"
                  : "Search results"
                : isAr
                  ? "أدلة مقترحة"
                  : "Featured guides"}
            </h2>
            {results.length ? (
              results.map((result) => (
                <HelpResultCard
                  key={`${result.type ?? "article"}-${result.slug}`}
                  result={result}
                />
              ))
            ) : (
              <p>
                {isAr
                  ? "لا توجد نتائج مطابقة. جرب كلمات أخرى أو تواصل معنا."
                  : "No matching results. Try another search or contact us."}
              </p>
            )}
          </div>
        </div>
        <HelpSupportCta />
      </section>
      <FaqSection />
    </>
  );
}

function HelpResultCard({ result }: { result: HelpArticleSummary }) {
  const { locale } = useCms(),
    path = result.type === "faq" ? "/resources" : `/resources/${result.slug}`;
  return (
    <article className="help-result-card">
      <span>
        {result.categoryName ?? result.categorySlug ?? (locale === "ar" ? "دليل" : "Guide")}
      </span>
      <h3>
        <Link to={path}>{result.title}</Link>
      </h3>
      <p>{result.summary}</p>
      <Link className="text-link" to={path}>
        {locale === "ar" ? "اقرأ الدليل" : "Read guide"} <span>→</span>
      </Link>
    </article>
  );
}

function HelpArticlePage() {
  const { slug = "" } = useParams();
  const { locale } = useCms();
  const preloadMap = useContext(PreloadContext);
  const [data, setData] = useState<any>(
    () => getPreloaded(preloadMap, helpArticlePreloadKey(slug, locale)) ?? null,
  );
  const [missing, setMissing] = useState(false);
  const isAr = locale === "ar";
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setMissing(false);
    void loadHelpArticle(slug, locale)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setMissing(true);
          return;
        }
        setData(result);
        applyPageMetadata(
          result.article.seo_title ?? result.article.title,
          result.article.meta_description ?? result.article.summary,
          result.article.canonical_path ?? `/resources/${result.article.slug}`,
          {
            robots: `${result.article.robots_index === false ? "noindex" : "index"},${result.article.robots_follow === false ? "nofollow" : "follow"}`,
          },
        );
      })
      .catch(() => setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [slug, locale]);
  if (missing) return <NotFoundPage />;
  if (!data)
    return (
      <section className="section">
        <p>{isAr ? "جاري تحميل الدليل…" : "Loading guide…"}</p>
      </section>
    );
  const article = data.article;
  return (
    <>
      <article className={`section help-article ${isAr ? "help-article--rtl" : ""}`}>
        <Link className="text-link" to="/resources">
          ← {isAr ? "مركز المساعدة" : "Help Center"}
        </Link>
        <header>
          <span>{article.categoryName}</span>
          <h1>{article.title}</h1>
          <p>{article.summary}</p>
        </header>
        <div className="help-article-body">
          {(article.body ?? []).map((block: HelpArticleBlock, index: number) => (
            <HelpArticleBlockView key={index} block={block} />
          ))}
        </div>
        {data.related?.length ? (
          <aside className="related-guides">
            <h2>{isAr ? "أدلة ذات صلة" : "Related guides"}</h2>
            {data.related.map((item: HelpArticleSummary) => (
              <Link key={item.slug} to={`/resources/${item.slug}`}>
                {item.title}
              </Link>
            ))}
          </aside>
        ) : null}
      </article>
      <HelpSupportCta />
    </>
  );
}

function HelpArticleBlockView({ block }: { block: HelpArticleBlock }) {
  if (block.type === "h2") return <h2>{block.text}</h2>;
  if (block.type === "h3") return <h3>{block.text}</h3>;
  if (block.type === "blockquote") return <blockquote>{block.text}</blockquote>;
  if (block.type === "bullet_list")
    return (
      <ul>
        {block.items?.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  if (block.type === "numbered_list")
    return (
      <ol>
        {block.items?.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    );
  if (block.type === "image" && block.url)
    return <img className="help-article-image" src={block.url} alt={block.alt ?? ""} />;
  return <p>{block.text}</p>;
}

function HelpSupportCta() {
  const { locale } = useCms();
  const isAr = locale === "ar";
  return (
    <section className="help-support-cta">
      <div>
        <span>{isAr ? "هل تحتاج مساعدة؟" : "Need help?"}</span>
        <h2>
          {isAr
            ? "يوسف وفريق Tawseelhub هنا للمساعدة."
            : "Yousef and the Tawseelhub team can help."}
        </h2>
        <p>
          {isAr
            ? "استخدم مساعد Tawseelhub أو تواصل معنا عبر واتساب أو صفحة التواصل."
            : "Use Ask Tawseelhub, WhatsApp, or the Contact page if you need a human follow-up."}
        </p>
      </div>
      <div className="hero-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("tawseelhub:open-agent"))}
        >
          {isAr ? "اسأل Tawseelhub" : "Ask Tawseelhub"}
        </button>
        <Link className="button button-secondary" to="/contact">
          {isAr ? "تواصل معنا" : "Contact us"}
        </Link>
      </div>
    </section>
  );
}

function FaqSection() {
  const { cms, locale } = useCms(),
    faqs = cms?.faqs ?? [];
  if (!faqs.length) return null;
  return (
    <section className="section faq-section">
      <SectionHeading
        eyebrow={locale === "ar" ? "الأسئلة الشائعة" : "FAQs"}
        title={locale === "ar" ? "إجابات واضحة من Tawseelhub." : "Clear answers from Tawseelhub."}
        copy={
          locale === "ar"
            ? "محتوى الأسئلة الشائعة منشور من منصة Tawseelhub فقط."
            : "FAQ content is published only from the Tawseelhub Platform."
        }
      />
      <div className="faq-list">
        {faqs.map((faq) => (
          <article key={faq.faqKey}>
            <h3>{faq.data.question}</h3>
            <p>{faq.data.answer}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
function FaqPage() {
  const { locale } = useCms();
  const isAr = locale === "ar";
  return (
    <>
      <InnerHero
        eyebrow={isAr ? "الأسئلة الشائعة" : "FAQs"}
        title={isAr ? "أسئلة شائعة عن Tawseelhub" : "Frequently Asked Questions"}
        copy={
          isAr
            ? "كل ما تحتاج معرفته عن برنامج إدارة التوصيل في الإمارات — من إدارة السائقين ومطابقة الدفع عند الاستلام إلى تسويات التجار والرواتب."
            : "Everything you need to know about Tawseelhub — delivery management software for the UAE, from courier management and COD reconciliation to trader settlements, driver payroll and pricing."
        }
        action={
          <Link className="button button-primary" to="/request-demo">
            {publicUi[locale].requestDemo}
          </Link>
        }
      />
      <section className="section">
        <div className="home-faq-list">
          {homeFaqs.map((faq) => (
            <details key={faq.q.en}>
              <summary>{faq.q[locale]}</summary>
              <p>{faq.a[locale]}</p>
            </details>
          ))}
        </div>
      </section>
      <FinalCta />
    </>
  );
}
function AboutPage() {
  const { locale } = useCms();
  const isAr = locale === "ar";
  const copy = isAr
    ? {
        eyebrow: "عن Tawseelhub",
        title: "نبني نظام التشغيل الذي تستحقه شركات التوصيل.",
        body: "صُمم Tawseelhub حول واقع عمليات التوصيل في الإمارات: الطلبات المتحركة، فرق الميدان، التحصيل، والعلاقات التجارية.",
        whatEyebrow: "ما هو Tawseelhub",
        whatTitle: "نظام تشغيل توصيل واحد، لا مجموعة أدوات متفرقة.",
        whatBody:
          "تدير معظم شركات التوصيل عملها اليوم عبر واتساب وجداول بيانات وأنظمة منفصلة للطلبات والتحصيل والمحاسبة. يجمع Tawseelhub هذه الأجزاء في نظام تشغيل واحد مترابط — طلب واحد يمر عبر الإسناد والتوصيل والتحصيل والتسوية والمحاسبة دون إعادة إدخال يدوي في كل مرحلة.",
        whoEyebrow: "لمن نبنيه",
        whoTitle: "ثلاثة أطراف على نفس النظام.",
        who: [
          [
            "شركات التوصيل",
            "الأساس الذي بُني حوله Tawseelhub: إدارة الطلبات والسائقين والتحصيل والتسويات والمحاسبة والرواتب من مساحة عمل واحدة.",
          ],
          [
            "التجار",
            "ربط علاقة توصيل قائمة أو طلب المساعدة في إيجاد واحدة، مع رؤية واضحة لحالة الطلبات والتسويات دون الوصول إلى دليل شركات عام.",
          ],
          [
            "عملاء إرسال الشحنات",
            "طلب عرض توصيل لشحنة داخل الإمارات أو دولياً دون الحاجة إلى حساب أو علاقة تجارية قائمة.",
          ],
        ],
        financeEyebrow: "العمليات + التحكم المالي",
        financeTitle: "كل عملية توصيل لها أثر مالي — نتتبعه من البداية.",
        financeBody:
          "تسليم طلب، وتحصيل دفعة عند الاستلام، وتسوية مستحقات تاجر ليست أحداثاً منفصلة عن الدفاتر المحاسبية — هي الدفاتر المحاسبية. عندما تتغير حالة الطلب في Tawseelhub، تتحرك الأرقام المالية المرتبطة به معها، بدلاً من أن تُدخل يدوياً في نظام محاسبي منفصل لاحقاً.",
      }
    : {
        eyebrow: "About Tawseelhub",
        title: "Building the operating system delivery businesses deserve.",
        body: "Tawseelhub is designed around the realities of UAE delivery operations: moving orders, field teams, collections and commercial relationships.",
        whatEyebrow: "What Tawseelhub is",
        whatTitle: "One delivery operating system, not a pile of separate tools.",
        whatBody:
          "Most delivery companies run their business today across WhatsApp, spreadsheets, and disconnected systems for orders, collections and accounting. Tawseelhub exists to bring those pieces into one connected operating system — a single order moves through assignment, delivery, collection, settlement and accounting without being re-typed at every stage.",
        whoEyebrow: "Who it is built for",
        whoTitle: "Three sides of the same system.",
        who: [
          [
            "Delivery Companies",
            "The foundation Tawseelhub is built around: managing orders, drivers, COD collections, Trader settlements, accounting and payroll from one workspace.",
          ],
          [
            "Traders",
            "Connect an existing delivery relationship, or ask for help finding one — with clear visibility into order status and settlements, without exposing a public Delivery Company directory.",
          ],
          [
            "Send-a-Package customers",
            "Request a delivery quotation for a package within the UAE or internationally, with no account or existing business relationship required.",
          ],
        ],
        financeEyebrow: "Operations + financial control",
        financeTitle: "Every delivery event has a financial consequence — tracked from the start.",
        financeBody:
          "Delivering an order, collecting a COD payment, settling what is owed to a Trader — these are not separate from the accounting record, they are the accounting record. When an order’s status changes in Tawseelhub, the financial figures tied to it move with it, instead of being re-entered by hand into a separate accounting system afterwards.",
      };
  return (
    <>
      <InnerHero eyebrow={copy.eyebrow} title={copy.title} copy={copy.body} />
      <section className="section about-grid">
        <div>
          <h2>{copy.whatTitle}</h2>
          <p>{copy.whatBody}</p>
        </div>
        <ProofStrip />
      </section>
      <section className="section why-section">
        <div className="section-heading">
          <p className="eyebrow">
            <span />
            {copy.whoEyebrow}
          </p>
          <h2>{copy.whoTitle}</h2>
        </div>
        <div className="dc-group-grid">
          {copy.who.map(([title, body]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="section">
        <SectionHeading
          eyebrow={copy.financeEyebrow}
          title={copy.financeTitle}
          copy={copy.financeBody}
        />
      </section>
      <FinalCta />
    </>
  );
}
function ContactPage() {
  const { cms, locale } = useCms(),
    copy = publicUi[locale],
    phone = cms?.contact?.publicPhone ?? "+971 50 689 8604";
  return (
    <>
      <InnerHero
        eyebrow={locale === "ar" ? "تواصل معنا" : "Contact"}
        title={copy.contactTitle}
        copy={`${copy.contactCopy} ${phone}.`}
        action={
          <Link className="button button-primary" to="/request-demo">
            {copy.requestDemo}
          </Link>
        }
      />
      <section className="section contact-panels">
        <article>
          <span>{copy.productEnquiries}</span>
          <h2>{copy.demoContext}</h2>
          <p>{copy.demoContextCopy}</p>
        </article>
        <article>
          <span>{copy.directContact}</span>
          <h2>{copy.talk}</h2>
          <p>
            <a href={phoneHref(phone)}>
              <bdi dir="ltr">{phone}</bdi>
            </a>
          </p>
          <WhatsAppContactButton />
        </article>
      </section>
      <ContactForm />
      <section className="section contact-location">
        <h2>{locale === "ar" ? "موقعنا" : "Our location"}</h2>
        <p>
          {locale === "ar"
            ? "محل رقم 9، فريج أفينيو، الحميدية، عجمان، الإمارات العربية المتحدة"
            : "Shop No. 9, Freej Avenue, Al Hamidiya, Ajman, United Arab Emirates"}
        </p>
        <a
          className="button button-secondary"
          href="https://www.google.com/maps/search/?api=1&query=Freej+Avenue+Al+Hamidiya+Ajman+UAE"
          rel="noreferrer"
          target="_blank"
        >
          {locale === "ar" ? "افتح في خرائط جوجل" : "Open in Google Maps"}
        </a>
        <p>
          {locale === "ar"
            ? "نخدم حالياً شركات وتجار وعمليات التوصيل داخل الإمارات العربية المتحدة."
            : "We currently serve delivery companies, Traders and delivery operations within the United Arab Emirates."}
        </p>
      </section>
    </>
  );
}

function ContactForm() {
  const { locale } = useCms();
  const isAr = locale === "ar";
  const [form, setForm] = useState({
    name: "",
    company: "",
    email: "",
    mobile: "",
    country: "United Arab Emirates",
    subject: "",
    message: "",
  });
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (
      !form.name.trim() ||
      !form.company.trim() ||
      !form.email.trim() ||
      !form.mobile.trim() ||
      !form.message.trim()
    ) {
      setError(
        isAr
          ? "يرجى تعبئة الاسم والشركة والبريد والجوال والرسالة."
          : "Please fill in name, company, email, mobile and message.",
      );
      return;
    }
    setStatus("busy");
    setError("");
    try {
      const result = await submitDemoRequest({
        companyName: form.company.trim(),
        contactPerson: form.name.trim(),
        mobileNumber: form.mobile.trim(),
        email: form.email.trim(),
        country: form.country,
        preferredContactMethod: "email",
        mainChallenges: `${form.subject.trim() ? `Subject: ${form.subject.trim()}\n\n` : ""}${form.message.trim()}`,
        consent: true,
        landingPage: "/contact",
        source: "contact_page",
      });
      setReference(result.referenceNumber);
      setStatus("done");
      trackEvent("contact_form_submitted", { page: "/contact", locale });
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof DemoRequestError
          ? err.message
          : isAr
            ? "تعذر إرسال الرسالة الآن. حاول مرة أخرى."
            : "Could not send your message right now. Please try again.",
      );
    }
  };
  if (status === "done")
    return (
      <section className="section contact-form-section">
        <div className="demo-success">
          <b>{isAr ? "تم استلام رسالتك" : "Message received"}</b>
          <p>
            {isAr
              ? "سيتواصل فريق Tawseelhub معك قريباً."
              : "The Tawseelhub team will follow up with you shortly."}
          </p>
          <p>
            {isAr ? "الرقم المرجعي" : "Reference"}: <bdi dir="ltr">{reference}</bdi>
          </p>
        </div>
      </section>
    );
  return (
    <section className="section contact-form-section">
      <SectionHeading
        eyebrow={isAr ? "راسلنا" : "Send a message"}
        title={isAr ? "أرسل استفسارك مباشرة." : "Send your enquiry directly."}
        copy={
          isAr
            ? "سيصل هذا النموذج إلى فريق Tawseelhub مباشرة."
            : "This form reaches the Tawseelhub team directly."
        }
      />
      <div className="demo-form-section">
        <div className="quote-fields">
          <Field label={isAr ? "الاسم" : "Name"} required>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label={isAr ? "الشركة" : "Company"} required>
            <input value={form.company} onChange={(e) => set("company", e.target.value)} />
          </Field>
          <Field label={isAr ? "البريد الإلكتروني" : "Email"} required>
            <input
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>
          <Field label={isAr ? "الجوال" : "Mobile"} required>
            <input
              dir="ltr"
              placeholder="+971501234567"
              value={form.mobile}
              onChange={(e) => set("mobile", e.target.value)}
            />
          </Field>
          <Field label={isAr ? "الدولة" : "Country"} required>
            <select value={form.country} onChange={(e) => set("country", e.target.value)}>
              {countriesByLocale[locale].map(([code, name]) => (
                <option key={code} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={isAr ? "الموضوع" : "Subject"}>
            <input value={form.subject} onChange={(e) => set("subject", e.target.value)} />
          </Field>
          <Field label={isAr ? "الرسالة" : "Message"} required full>
            <textarea
              maxLength={2000}
              value={form.message}
              onChange={(e) => set("message", e.target.value)}
            />
          </Field>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="button button-primary"
          disabled={status === "busy"}
          onClick={() => void submit()}
        >
          {status === "busy"
            ? isAr
              ? "جاري الإرسال…"
              : "Sending…"
            : isAr
              ? "إرسال الرسالة"
              : "Send Message"}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  required,
  full,
  children,
}: {
  label: string;
  required?: boolean;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={full ? "full" : undefined}>
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}

function WhatsAppContactButton() {
  const { locale } = useCms();
  const [settings, setSettings] = useState<WhatsAppPublicSettings | null>(null);
  useEffect(() => {
    void getWhatsAppSettings().then(setSettings);
  }, []);
  if (!settings?.enabled || !settings.url) return null;
  return (
    <a
      className="button button-secondary"
      href={buildWhatsAppMessageUrl(
        settings.url,
        locale === "ar"
          ? "مرحباً، أود التواصل مع Tawseelhub على واتساب."
          : "Hi, I would like to contact Tawseelhub on WhatsApp.",
      )}
      target="_blank"
      rel="noreferrer"
      onClick={() => {
        trackEvent("whatsapp_contact_started", {
          page: window.location.pathname,
          initiated_from: "website_cta",
          locale,
        });
        trackCta({
          ctaId: "contact_whatsapp",
          destinationType: "whatsapp",
          audience: "unknown",
          locale,
          ctaLocation: "contact",
        });
      }}
    >
      {locale === "ar" ? "تواصل عبر واتساب" : "Chat on WhatsApp"}
    </a>
  );
}
function NotFoundPage() {
  const { locale } = useCms(),
    copy = publicUi[locale];
  return (
    <InnerHero
      eyebrow={copy.pageNotFound}
      title={copy.routeUnavailable}
      copy={
        locale === "ar"
          ? "ارجع إلى صفحة Tawseelhub الرئيسية لاستكشاف نظام تشغيل التوصيل."
          : "Return to the Tawseelhub homepage to explore the delivery operating system."
      }
      action={
        <Link className="button button-primary" to="/">
          {copy.returnHome}
        </Link>
      }
    />
  );
}

export function Footer() {
  const { cms, locale } = useCms(),
    copy = publicUi[locale],
    phone = cms?.contact?.publicPhone ?? "+971 50 689 8604";
  const groups =
    locale === "ar"
      ? ([
          [
            "لشركات التوصيل",
            [
              ["المزايا", "/delivery-companies"],
              ["الأسعار", "/pricing"],
              ["اطلب عرضاً", "/request-demo"],
              ["التكاملات", "/integrations"],
            ],
          ],
          [
            "للتجار",
            [
              ["حالة المتجر", "/traders"],
              ["تسجيل تاجر", "/traders/register"],
              ["التكاملات", "/integrations"],
            ],
          ],
          [
            "أرسل شحنة",
            [
              ["احصل على عرض", "/send-a-package"],
              ["الأسعار", "/pricing"],
            ],
          ],
          [
            "الموارد",
            [
              ["المدونة", "/blog"],
              ["الأدلة", "/resources"],
              ["الأسئلة الشائعة", "/faq"],
            ],
          ],
          [
            "الشركة",
            [
              ["من نحن", "/about"],
              ["تواصل معنا", "/contact"],
              ["الخصوصية", "/privacy"],
              ["الشروط", "/terms"],
            ],
          ],
        ] as const)
      : ([
          [
            "For Delivery Companies",
            [
              ["Features", "/delivery-companies"],
              ["Pricing", "/pricing"],
              ["Request Demo", "/request-demo"],
              ["Integrations", "/integrations"],
            ],
          ],
          [
            "For Traders",
            [
              ["Store status", "/traders"],
              ["Register as Trader", "/traders/register"],
              ["Integrations", "/integrations"],
            ],
          ],
          [
            "Send a Package",
            [
              ["Get a Quote", "/send-a-package"],
              ["Pricing", "/pricing"],
            ],
          ],
          [
            "Resources",
            [
              ["Blog", "/blog"],
              ["Guides", "/resources"],
              ["FAQs", "/faq"],
            ],
          ],
          [
            "Company",
            [
              ["About Us", "/about"],
              ["Contact Us", "/contact"],
              ["Privacy Policy", "/privacy"],
              ["Terms of Service", "/terms"],
            ],
          ],
        ] as const);
  return (
    <footer>
      <div className="footer-main">
        <div className="footer-brand">
          <div className="footer-wordmark" aria-label="Tawseelhub">
            Tawseelhub
          </div>
          <strong>{copy.deliveryOperatingSystem}</strong>
          <p>
            {locale === "ar"
              ? "عمليات ونمو مترابطة لشركات التوصيل الحديثة."
              : "Connected operations and growth for modern delivery companies."}
          </p>
          <a href={phoneHref(phone)}>
            <bdi dir="ltr">{phone}</bdi>
          </a>
        </div>
        {groups.map(([title, links]) => (
          <div className="footer-group" key={title}>
            <h2>{title}</h2>
            {links.map(([label, href]) => (
              <Link key={label} to={href}>
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Tawseelhub</span>
        <span>{copy.footerReady}</span>
      </div>
    </footer>
  );
}
