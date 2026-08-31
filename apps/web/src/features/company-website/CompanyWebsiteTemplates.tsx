import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import "./company-website-banner.css";

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

export interface CompanyWebsiteContent {
  readonly name: string;
  readonly headline?: string;
  readonly description: string | null;
  readonly about?: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly logoUrl: string | null;
  readonly bannerUrls?: readonly string[];
  readonly bannerTransition?: "fade" | "slide" | "zoom";
  readonly bannerIntervalSeconds?: 4 | 6 | 8;
  readonly bannerSize?: "compact" | "standard" | "full";
  readonly direction: "ltr" | "rtl";
  readonly language?: "en" | "ar";
  readonly theme?: { primary?: string; secondary?: string; accent?: string };
  readonly services?: ReadonlyArray<{ id: string; title: string; description?: string }>;
  readonly coverage?: ReadonlyArray<{ id: string; emirate: string; area?: string }>;
  readonly benefits?: ReadonlyArray<{ id: string; title: string; description?: string }>;
  readonly marketing?: {
    steps: ReadonlyArray<{ id: string; title: string; description?: string }>;
    industries: ReadonlyArray<{ id: string; title: string; description?: string }>;
    statistics: ReadonlyArray<{ id: string; title: string; description?: string }>;
    testimonials: ReadonlyArray<{ id: string; title: string; description?: string }>;
  };
  readonly workingHours?: ReadonlyArray<{
    day: string;
    closed: boolean;
    opens?: string;
    closes?: string;
  }>;
  readonly socialLinks?: Readonly<Record<string, string>>;
  readonly sections?: ReadonlyArray<{ key: string; enabled: boolean; order: number }>;
  readonly whatsappUrl?: string | null;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly alternateLanguage?: { label: string; url: string };
  readonly navigation?: {
    about: string;
    services: string;
    coverage: string;
    track: string;
    request: string;
    contact: string;
    suffix: string;
  };
  readonly primaryCta?: { label: string; href: string };
  readonly secondaryCta?: { label: string; href: string };
  readonly trackingSection?: ReactNode;
}

const templateCopy = {
  en: {
    services: "Services",
    coverage: "Coverage areas",
    benefits: "Why choose us",
    hours: "Working hours",
    closed: "Closed",
    location: "Location",
    map: "View map",
    contact: "Contact",
    connect: "Let’s connect",
    powered: "Powered by Tawseelhub",
    companyOverview: "Company overview",
    dependable: "Built around dependable service",
    professional: "Professional delivery services",
    reliable: "Reliable",
    structured: "Structured",
    connected: "Connected",
    digital: "Digital delivery",
    clear: "Delivery, made clear",
    operations: "Connected operations",
    presence: "Local presence",
    responsive: "Responsive service",
    availability: "Contact the company directly for delivery availability.",
    move: "Move now",
    fast: "Fast action. Direct contact.",
    need: "Need a delivery?",
    confirm: "Contact our team to confirm timing and coverage.",
    here: "Here for your delivery",
    local: "Your local delivery team",
    reachable: "A delivery company you can reach",
    considered: "Considered delivery",
    specialist: "Specialist courier service",
    approach: "Our approach",
    care: "Care in every detail",
    whatsapp: "WhatsApp",
    email: "Email us",
    book: "Book Delivery",
    call: "Call",
  },
  ar: {
    services: "الخدمات",
    coverage: "مناطق التغطية",
    benefits: "لماذا تختارنا",
    hours: "ساعات العمل",
    closed: "مغلق",
    location: "الموقع",
    map: "عرض الخريطة",
    contact: "تواصل معنا",
    connect: "لنتواصل",
    powered: "بدعم من توصيل هب",
    companyOverview: "نبذة عن الشركة",
    dependable: "خدمة موثوقة تلبي احتياجاتك",
    professional: "خدمات توصيل احترافية",
    reliable: "موثوق",
    structured: "منظم",
    connected: "متصل",
    digital: "توصيل رقمي",
    clear: "توصيل واضح وبسيط",
    operations: "عمليات مترابطة",
    presence: "حضور محلي",
    responsive: "خدمة سريعة الاستجابة",
    availability: "تواصل مع الشركة مباشرة للتأكد من توفر خدمة التوصيل.",
    move: "ابدأ الآن",
    fast: "إجراء سريع وتواصل مباشر",
    need: "تحتاج إلى توصيل؟",
    confirm: "تواصل مع فريقنا لتأكيد الموعد ونطاق التغطية.",
    here: "معك في كل توصيل",
    local: "فريق التوصيل المحلي",
    reachable: "شركة توصيل قريبة منك",
    considered: "توصيل بعناية",
    specialist: "خدمة توصيل متخصصة",
    approach: "نهجنا",
    care: "عناية في كل التفاصيل",
    whatsapp: "واتساب",
    email: "راسلنا",
    book: "احجز توصيلاً",
    call: "اتصل",
  },
} as const;
const words = (content: CompanyWebsiteContent) =>
  templateCopy[content.language ?? (content.direction === "rtl" ? "ar" : "en")];
const marketingHeadings = {
  en: {
    steps: "How it works",
    industries: "Industries served",
    statistics: "Trusted delivery at a glance",
    testimonials: "What customers say",
  },
  ar: {
    steps: "كيف تعمل الخدمة",
    industries: "القطاعات التي نخدمها",
    statistics: "أرقام تعكس ثقتكم",
    testimonials: "آراء العملاء",
  },
} as const;
function localizedDay(day: string, language: "en" | "ar" | undefined): string {
  if (language !== "ar") return day;
  return (
    (
      {
        monday: "الاثنين",
        tuesday: "الثلاثاء",
        wednesday: "الأربعاء",
        thursday: "الخميس",
        friday: "الجمعة",
        saturday: "السبت",
        sunday: "الأحد",
      } as Record<string, string>
    )[day] ?? day
  );
}

interface TemplateDefinition {
  readonly name: string;
  readonly render: (content: CompanyWebsiteContent) => ReactNode;
}

function Hero({
  content,
  children,
}: {
  content: CompanyWebsiteContent;
  children: ReactNode;
}): ReactNode {
  const banners = content.bannerUrls ?? [];
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (banners.length < 2 || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return;
    const timer = globalThis.setInterval(
      () => setActive((current) => (current + 1) % banners.length),
      (content.bannerIntervalSeconds ?? 6) * 1000,
    );
    return () => globalThis.clearInterval(timer);
  }, [banners.length, content.bannerIntervalSeconds]);
  useEffect(() => {
    if (active >= banners.length) setActive(0);
  }, [active, banners.length]);
  const move = (step: number) =>
    setActive((current) => (current + step + banners.length) % banners.length);
  return (
    <section className="site-template__hero">
      {banners.length ? (
        <div
          className={`site-template__banner site-template__banner--${content.bannerTransition ?? "fade"}`}
        >
          <img alt="" aria-hidden="true" key={active} src={banners[active]} />
          {banners.length > 1 ? (
            <div className="site-template__banner-controls" aria-label="Homepage banners">
              <button aria-label="Previous banner" onClick={() => move(-1)} type="button">
                ‹
              </button>
              <span>
                {banners.map((_, index) => (
                  <button
                    aria-label={`Show banner ${index + 1}`}
                    aria-current={index === active ? "true" : undefined}
                    key={index}
                    onClick={() => setActive(index)}
                    type="button"
                  />
                ))}
              </span>
              <button aria-label="Next banner" onClick={() => move(1)} type="button">
                ›
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function Header({ content, label }: { content: CompanyWebsiteContent; label: string }): ReactNode {
  const enabled = new Map(
    (content.sections ?? []).map((section) => [section.key, section.enabled]),
  );
  const nav = content.navigation ?? {
    about: "About",
    services: "Services",
    coverage: "Coverage",
    track: "Track",
    request: "Request Delivery",
    contact: "Contact",
    suffix: "",
  };
  return (
    <header className="site-template__header">
      {content.logoUrl ? (
        <img alt={`${content.name} logo`} loading="eager" src={content.logoUrl} />
      ) : (
        <strong>{content.name}</strong>
      )}
      <nav aria-label="Main navigation">
        <a href={`/${nav.suffix}#about`}>{nav.about}</a>
        {enabled.get("services") !== false ? (
          <a href={`/${nav.suffix}#services`}>{nav.services}</a>
        ) : null}
        {enabled.get("coverage") !== false ? (
          <a href={`/${nav.suffix}#coverage`}>{nav.coverage}</a>
        ) : null}
        {enabled.get("tracking") !== false ? <a href={`/track${nav.suffix}`}>{nav.track}</a> : null}
        {enabled.get("request_delivery") !== false ? (
          <a href={`/request-delivery${nav.suffix}`}>{nav.request}</a>
        ) : null}
        <a href={`/contact${nav.suffix}`}>{nav.contact}</a>
      </nav>
      {content.alternateLanguage ? (
        // Outside the nav on purpose: on mobile the nav is a horizontal
        // scroll strip and its last links sit beyond the fold -- which made
        // the language switch effectively invisible there. As a standalone
        // pill it stays pinned in the header's top row at every size.
        <a className="site-template__lang" href={content.alternateLanguage.url}>
          {content.alternateLanguage.label}
        </a>
      ) : null}
      <span>{label}</span>
    </header>
  );
}

function Actions({
  content,
  express = false,
}: {
  content: CompanyWebsiteContent;
  express?: boolean;
}): ReactNode {
  const text = words(content);
  if (
    !content.phone &&
    !content.email &&
    !content.whatsappUrl &&
    !content.primaryCta &&
    !content.secondaryCta
  )
    return null;
  return (
    <div className="site-template__actions">
      {content.primaryCta ? (
        <a className="site-template__primary" href={content.primaryCta.href}>
          {content.primaryCta.label}
        </a>
      ) : content.phone ? (
        <a className="site-template__primary" href={`tel:${content.phone.replace(/[^+\d]/gu, "")}`}>
          {express ? (
            text.book
          ) : (
            <>
              {text.call} <bdi dir="ltr">{content.phone}</bdi>
            </>
          )}
        </a>
      ) : null}
      {content.secondaryCta ? (
        <a href={content.secondaryCta.href}>{content.secondaryCta.label}</a>
      ) : content.email ? (
        <a href={`mailto:${content.email}`}>{text.email}</a>
      ) : null}
      {content.whatsappUrl ? (
        <a href={content.whatsappUrl} rel="noreferrer" target="_blank">
          {text.whatsapp}
        </a>
      ) : null}
    </div>
  );
}

function Contact({ content }: { content: CompanyWebsiteContent }): ReactNode {
  const text = words(content);
  const enabled = new Map(
    (content.sections ?? []).map((section) => [section.key, section.enabled]),
  );
  const order = (key: string): number =>
    content.sections?.find((section) => section.key === key)?.order ?? 0;
  return (
    <div className="site-template__ordered">
      {enabled.get("services") !== false && content.services?.length ? (
        <section
          className="site-template__collection"
          id="services"
          style={{ order: order("services") }}
        >
          <h2>{text.services}</h2>
          <div>
            {content.services.map((item) => (
              <article key={item.id}>
                <h3>{item.title}</h3>
                {item.description ? <p>{item.description}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {enabled.get("coverage") !== false && content.coverage?.length ? (
        <section
          className="site-template__collection"
          id="coverage"
          style={{ order: order("coverage") }}
        >
          <h2>{text.coverage}</h2>
          <div>
            {content.coverage.map((item) => (
              <article key={item.id}>
                <h3>{item.emirate}</h3>
                {item.area ? <p>{item.area}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {enabled.get("benefits") !== false && content.benefits?.length ? (
        <section className="site-template__collection" style={{ order: order("benefits") }}>
          <h2>{text.benefits}</h2>
          <div>
            {content.benefits.map((item) => (
              <article key={item.id}>
                <h3>{item.title}</h3>
                {item.description ? <p>{item.description}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {content.marketing
        ? (["steps", "industries", "statistics", "testimonials"] as const).map((kind) => {
            const sectionKey = kind === "steps" ? "how_it_works" : kind;
            const items = content.marketing?.[kind] ?? [];
            if (enabled.get(sectionKey) === false || items.length === 0) return null;
            const heading =
              marketingHeadings[content.language ?? (content.direction === "rtl" ? "ar" : "en")][
                kind
              ];
            return (
              <section
                className={`site-template__collection site-template__marketing site-template__marketing--${kind}`}
                id={sectionKey}
                key={kind}
                style={{ order: order(sectionKey) }}
              >
                <h2>{heading}</h2>
                <div>
                  {items.map((item, index) => (
                    <article key={item.id}>
                      {kind === "steps" ? (
                        <span className="site-template__step-number">{index + 1}</span>
                      ) : null}
                      <h3>{item.title}</h3>
                      {item.description ? <p>{item.description}</p> : null}
                    </article>
                  ))}
                </div>
              </section>
            );
          })
        : null}
      {enabled.get("working_hours") !== false && content.workingHours?.length ? (
        <section className="site-template__hours" style={{ order: order("working_hours") }}>
          <h2>{text.hours}</h2>
          {content.workingHours.map((item) => (
            <p key={item.day}>
              <strong>{localizedDay(item.day, content.language)}</strong>{" "}
              {item.closed ? text.closed : `${item.opens}–${item.closes}`}
            </p>
          ))}
        </section>
      ) : null}
      {enabled.get("location") !== false &&
      content.latitude !== undefined &&
      content.longitude !== undefined ? (
        <section className="site-template__location" style={{ order: order("location") }}>
          <h2>{text.location}</h2>
          <a
            href={`https://www.openstreetmap.org/?mlat=${content.latitude}&mlon=${content.longitude}`}
            rel="noreferrer"
            target="_blank"
          >
            {text.map}
          </a>
        </section>
      ) : null}
      {enabled.get("social") !== false &&
      content.socialLinks &&
      Object.keys(content.socialLinks).length ? (
        <section
          className="site-template__social"
          aria-label="Social links"
          style={{ order: order("social") }}
        >
          {Object.entries(content.socialLinks).map(([name, url]) => (
            <a href={url} key={name} rel="noreferrer" target="_blank">
              {name}
            </a>
          ))}
        </section>
      ) : null}
      {enabled.get("contact") !== false && (content.address || content.phone || content.email) ? (
        <section
          className="site-template__contact"
          id="contact"
          style={{ order: order("contact") }}
        >
          <p className="site-template__kicker">{text.contact}</p>
          <h2>{text.connect}</h2>
          {content.address ? <address>{content.address}</address> : null}
          {content.phone ? (
            // bdi/dir: a "+971..." number inside an RTL page renders with the
            // plus sign flipped to the wrong end without an LTR island.
            <a dir="ltr" href={`tel:${content.phone.replace(/[^+\d]/gu, "")}`}>
              <bdi dir="ltr">{content.phone}</bdi>
            </a>
          ) : null}
          {content.email ? <a href={`mailto:${content.email}`}>{content.email}</a> : null}
        </section>
      ) : null}
    </div>
  );
}

function Footer({ content }: { content: CompanyWebsiteContent }): ReactNode {
  return (
    <footer>
      <strong>{content.name}</strong>
      <span>{words(content).powered}</span>
    </footer>
  );
}

function Corporate(content: CompanyWebsiteContent): ReactNode {
  const text = words(content);
  return (
    <TemplateFrame content={content} keyName="corporate">
      <Header content={content} label={text.dependable} />
      <main>
        <Hero content={content}>
          <div>
            <p className="site-template__kicker">{text.professional}</p>
            <h1>{content.headline ?? content.name}</h1>
            {content.description ? <p>{content.description}</p> : null}
            <Actions content={content} />
          </div>
          <div className="site-template__trust" aria-hidden="true">
            <span>{text.reliable}</span>
            <span>{text.structured}</span>
            <span>{text.connected}</span>
          </div>
        </Hero>
        {content.trackingSection}
        <AboutSection content={content} heading={text.dependable} kicker={text.companyOverview} />
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Modern(content: CompanyWebsiteContent): ReactNode {
  const text = words(content);
  return (
    <TemplateFrame content={content} keyName="modern">
      <Header content={content} label={text.digital} />
      <main>
        <Hero content={content}>
          <p className="site-template__kicker">{text.clear}</p>
          <h1>{content.headline ?? content.name}</h1>
          {content.description ? <p>{content.description}</p> : null}
          <Actions content={content} />
        </Hero>
        {content.trackingSection}
        <section className="site-template__cards">
          <article>
            <span>01</span>
            <h2>{text.operations}</h2>
            <p>{text.availability}</p>
          </article>
          {content.address ? (
            <article>
              <span>02</span>
              <h2>{text.presence}</h2>
              <p>{content.address}</p>
            </article>
          ) : null}
          <article>
            <span>03</span>
            <h2>{text.responsive}</h2>
            <p>{text.availability}</p>
          </article>
        </section>
        <AboutSection content={content} heading={text.dependable} kicker={text.companyOverview} />
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Express(content: CompanyWebsiteContent): ReactNode {
  const text = words(content);
  return (
    <TemplateFrame content={content} keyName="express">
      <Header content={content} label={text.move} />
      <main>
        <Hero content={content}>
          <p className="site-template__kicker">{text.fast}</p>
          <h1>{content.headline ?? content.name}</h1>
          {content.description ? <p>{content.description}</p> : null}
          <Actions content={content} express />
        </Hero>
        {content.trackingSection}
        <section className="site-template__express-band">
          <strong>{text.need}</strong>
          <span>{text.confirm}</span>
        </section>
        <AboutSection content={content} heading={text.dependable} kicker={text.companyOverview} />
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Local(content: CompanyWebsiteContent): ReactNode {
  const text = words(content);
  return (
    <TemplateFrame content={content} keyName="local">
      <Header content={content} label={text.here} />
      <main>
        <Hero content={content}>
          <div className="site-template__local-mark" aria-hidden="true">
            ⌖
          </div>
          <div>
            <p className="site-template__kicker">{text.local}</p>
            <h1>{content.headline ?? content.name}</h1>
            {content.description ? <p>{content.description}</p> : null}
            <Actions content={content} />
          </div>
        </Hero>
        {content.trackingSection}
        <AboutSection content={content} heading={text.reachable} kicker={text.companyOverview} />
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Premium(content: CompanyWebsiteContent): ReactNode {
  const text = words(content);
  return (
    <TemplateFrame content={content} keyName="premium">
      <Header content={content} label={text.considered} />
      <main>
        <Hero content={content}>
          <div className="site-template__premium-line" />
          <p className="site-template__kicker">{text.specialist}</p>
          <h1>{content.headline ?? content.name}</h1>
          {content.description ? <p>{content.description}</p> : null}
          <Actions content={content} />
        </Hero>
        {content.trackingSection}
        <AboutSection content={content} heading={text.care} kicker={text.approach} />
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function AboutSection({
  content,
  heading,
  kicker,
}: {
  content: CompanyWebsiteContent;
  heading: string;
  kicker: string;
}): ReactNode {
  const about = content.about ?? content.description;
  return about ? (
    <section className="site-template__about" id="about">
      <header>
        <p className="site-template__kicker">{kicker}</p>
        <h2>{heading}</h2>
      </header>
      <div className="site-template__about-copy">
        <p>{about}</p>
      </div>
    </section>
  ) : null;
}

function DesignerTemplate(
  content: CompanyWebsiteContent,
  keyName: CompanyWebsiteTemplateKey,
  label: string,
): ReactNode {
  const text = words(content);
  return (
    <TemplateFrame content={content} keyName={keyName}>
      <Header content={content} label={label} />
      <main>
        <Hero content={content}>
          <div className="site-template__designer-copy">
            <p className="site-template__kicker">{text.professional}</p>
            <h1>{content.headline ?? content.name}</h1>
            {content.description ? <p>{content.description}</p> : null}
            <Actions content={content} />
          </div>
          <div className="site-template__designer-mark" aria-hidden="true">
            <span>{content.name.slice(0, 1)}</span>
          </div>
        </Hero>
        {content.trackingSection}
        <AboutSection content={content} heading={text.dependable} kicker={text.companyOverview} />
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function TemplateFrame({
  content,
  keyName,
  children,
}: {
  content: CompanyWebsiteContent;
  keyName: CompanyWebsiteTemplateKey;
  children: ReactNode;
}): ReactNode {
  const hidden = (content.sections ?? [])
    .filter((section) => !section.enabled)
    .map((section) => `site-hide-${section.key}`)
    .join(" ");
  return (
    <div
      className={`company-site site-template site-template--${keyName} ${content.bannerUrls?.length ? `site-template--has-banner site-template--banner-${content.bannerSize ?? "standard"}` : ""} ${hidden}`}
      data-template={keyName}
      dir={content.direction}
      style={
        {
          ...(content.theme?.primary ? { "--site-primary": content.theme.primary } : {}),
          ...(content.theme?.secondary ? { "--site-secondary": content.theme.secondary } : {}),
          ...(content.theme?.accent ? { "--site-accent": content.theme.accent } : {}),
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

export const COMPANY_WEBSITE_TEMPLATES: Readonly<
  Record<CompanyWebsiteTemplateKey, TemplateDefinition>
> = {
  corporate: { name: "Corporate", render: Corporate },
  modern: { name: "Modern", render: Modern },
  express: { name: "Express", render: Express },
  local: { name: "Local", render: Local },
  premium: { name: "Premium", render: Premium },
  skyline: {
    name: "Skyline",
    render: (content) => DesignerTemplate(content, "skyline", "Skyline delivery"),
  },
  minimal: {
    name: "Minimal",
    render: (content) => DesignerTemplate(content, "minimal", "Simply delivered"),
  },
  bold: {
    name: "Bold",
    render: (content) => DesignerTemplate(content, "bold", "Move with confidence"),
  },
  elegant: {
    name: "Elegant",
    render: (content) => DesignerTemplate(content, "elegant", "Service with distinction"),
  },
  urban: {
    name: "Urban",
    render: (content) => DesignerTemplate(content, "urban", "Built for the city"),
  },
  swift: {
    name: "Swift",
    render: (content) => DesignerTemplate(content, "swift", "Delivery in motion"),
  },
  horizon: {
    name: "Horizon",
    render: (content) => DesignerTemplate(content, "horizon", "Across every horizon"),
  },
  nexus: {
    name: "Nexus",
    render: (content) => DesignerTemplate(content, "nexus", "Connected delivery"),
  },
  oasis: {
    name: "Oasis",
    render: (content) => DesignerTemplate(content, "oasis", "Calm, reliable service"),
  },
  fleet: {
    name: "Fleet",
    render: (content) => DesignerTemplate(content, "fleet", "Your fleet advantage"),
  },
  commerce: {
    name: "Commerce",
    render: (content) => DesignerTemplate(content, "commerce", "Delivery for business"),
  },
  courier: {
    name: "Courier",
    render: (content) => DesignerTemplate(content, "courier", "Personal courier care"),
  },
  executive: {
    name: "Executive",
    render: (content) => DesignerTemplate(content, "executive", "Executive logistics"),
  },
  vibrant: {
    name: "Vibrant",
    render: (content) => DesignerTemplate(content, "vibrant", "Delivery with energy"),
  },
  classic: {
    name: "Classic",
    render: (content) => DesignerTemplate(content, "classic", "A tradition of trust"),
  },
};

export function renderCompanyWebsiteTemplate(
  key: CompanyWebsiteTemplateKey,
  content: CompanyWebsiteContent,
): ReactNode {
  return COMPANY_WEBSITE_TEMPLATES[key].render(content);
}
