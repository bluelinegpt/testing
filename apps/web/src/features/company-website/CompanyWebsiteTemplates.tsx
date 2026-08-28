import type { CSSProperties, ReactNode } from "react";

export type CompanyWebsiteTemplateKey = "corporate" | "modern" | "express" | "local" | "premium";

export interface CompanyWebsiteContent {
  readonly name: string;
  readonly headline?: string;
  readonly description: string | null;
  readonly about?: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly logoUrl: string | null;
  readonly direction: "ltr" | "rtl";
  readonly theme?: { primary?: string; secondary?: string; accent?: string };
  readonly services?: ReadonlyArray<{ id: string; title: string; description?: string }>;
  readonly coverage?: ReadonlyArray<{ id: string; emirate: string; area?: string }>;
  readonly benefits?: ReadonlyArray<{ id: string; title: string; description?: string }>;
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

interface TemplateDefinition {
  readonly name: string;
  readonly render: (content: CompanyWebsiteContent) => ReactNode;
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
        {content.alternateLanguage ? (
          <a href={content.alternateLanguage.url}>{content.alternateLanguage.label}</a>
        ) : null}
      </nav>
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
          {express ? "Book Delivery" : `Call ${content.phone}`}
        </a>
      ) : null}
      {content.secondaryCta ? (
        <a href={content.secondaryCta.href}>{content.secondaryCta.label}</a>
      ) : content.email ? (
        <a href={`mailto:${content.email}`}>Email us</a>
      ) : null}
      {content.whatsappUrl ? (
        <a href={content.whatsappUrl} rel="noreferrer" target="_blank">
          WhatsApp
        </a>
      ) : null}
    </div>
  );
}

function Contact({ content }: { content: CompanyWebsiteContent }): ReactNode {
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
          <h2>Services</h2>
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
          <h2>Coverage areas</h2>
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
          <h2>Why choose us</h2>
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
      {enabled.get("working_hours") !== false && content.workingHours?.length ? (
        <section className="site-template__hours" style={{ order: order("working_hours") }}>
          <h2>Working hours</h2>
          {content.workingHours.map((item) => (
            <p key={item.day}>
              <strong>{item.day}</strong> {item.closed ? "Closed" : `${item.opens}–${item.closes}`}
            </p>
          ))}
        </section>
      ) : null}
      {enabled.get("location") !== false &&
      content.latitude !== undefined &&
      content.longitude !== undefined ? (
        <section className="site-template__location" style={{ order: order("location") }}>
          <h2>Location</h2>
          <a
            href={`https://www.openstreetmap.org/?mlat=${content.latitude}&mlon=${content.longitude}`}
            rel="noreferrer"
            target="_blank"
          >
            View map
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
          <p className="site-template__kicker">Contact</p>
          <h2>Let’s connect</h2>
          {content.address ? <address>{content.address}</address> : null}
          {content.phone ? (
            <a href={`tel:${content.phone.replace(/[^+\d]/gu, "")}`}>{content.phone}</a>
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
      <span>Powered by Tawseelhub</span>
    </footer>
  );
}

function Corporate(content: CompanyWebsiteContent): ReactNode {
  return (
    <TemplateFrame content={content} keyName="corporate">
      <Header content={content} label="Delivery you can depend on" />
      <main>
        <section className="site-template__hero">
          <div>
            <p className="site-template__kicker">Professional delivery services</p>
            <h1>{content.headline ?? content.name}</h1>
            {content.description ? <p>{content.description}</p> : null}
            <Actions content={content} />
          </div>
          <div className="site-template__trust" aria-hidden="true">
            <span>Reliable</span>
            <span>Structured</span>
            <span>Connected</span>
          </div>
        </section>
        {content.trackingSection}
        {(content.about ?? content.description) ? (
          <section className="site-template__split" id="about">
            <div>
              <p className="site-template__kicker">Company overview</p>
              <h2>Built around dependable service</h2>
            </div>
            <p>{content.about ?? content.description}</p>
          </section>
        ) : null}
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Modern(content: CompanyWebsiteContent): ReactNode {
  return (
    <TemplateFrame content={content} keyName="modern">
      <Header content={content} label="Digital delivery" />
      <main>
        <section className="site-template__hero">
          <p className="site-template__kicker">Delivery, made clear</p>
          <h1>{content.headline ?? content.name}</h1>
          {content.description ? <p>{content.description}</p> : null}
          <Actions content={content} />
        </section>
        {content.trackingSection}
        <section className="site-template__cards" id="about">
          <article>
            <span>01</span>
            <h2>Connected operations</h2>
            {(content.about ?? content.description) ? (
              <p>{content.about ?? content.description}</p>
            ) : null}
          </article>
          {content.address ? (
            <article>
              <span>02</span>
              <h2>Local presence</h2>
              <p>{content.address}</p>
            </article>
          ) : null}
          <article>
            <span>03</span>
            <h2>Responsive service</h2>
            <p>Contact the company directly for delivery availability.</p>
          </article>
        </section>
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Express(content: CompanyWebsiteContent): ReactNode {
  return (
    <TemplateFrame content={content} keyName="express">
      <Header content={content} label="Move now" />
      <main>
        <section className="site-template__hero">
          <p className="site-template__kicker">Fast action. Direct contact.</p>
          <h1>{content.headline ?? content.name}</h1>
          {content.description ? <p>{content.description}</p> : null}
          <Actions content={content} express />
        </section>
        {content.trackingSection}
        <section className="site-template__express-band" id="about">
          <strong>Need a delivery?</strong>
          <span>Contact our team to confirm timing and coverage.</span>
        </section>
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Local(content: CompanyWebsiteContent): ReactNode {
  return (
    <TemplateFrame content={content} keyName="local">
      <Header content={content} label="Here for your delivery" />
      <main>
        <section className="site-template__hero">
          <div className="site-template__local-mark" aria-hidden="true">
            ⌖
          </div>
          <div>
            <p className="site-template__kicker">Your local delivery team</p>
            <h1>{content.headline ?? content.name}</h1>
            {content.description ? <p>{content.description}</p> : null}
            <Actions content={content} />
          </div>
        </section>
        {content.trackingSection}
        {(content.about ?? content.description) ? (
          <section className="site-template__local-about" id="about">
            <h2>A delivery company you can reach</h2>
            <p>{content.about ?? content.description}</p>
          </section>
        ) : null}
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </TemplateFrame>
  );
}

function Premium(content: CompanyWebsiteContent): ReactNode {
  return (
    <TemplateFrame content={content} keyName="premium">
      <Header content={content} label="Considered delivery" />
      <main>
        <section className="site-template__hero">
          <div className="site-template__premium-line" />
          <p className="site-template__kicker">Specialist courier service</p>
          <h1>{content.headline ?? content.name}</h1>
          {content.description ? <p>{content.description}</p> : null}
          <Actions content={content} />
        </section>
        {content.trackingSection}
        {(content.about ?? content.description) ? (
          <section className="site-template__premium-about" id="about">
            <p className="site-template__kicker">Our approach</p>
            <h2>Care in every detail</h2>
            <p>{content.about ?? content.description}</p>
          </section>
        ) : null}
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
      className={`company-site site-template site-template--${keyName} ${hidden}`}
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
};

export function renderCompanyWebsiteTemplate(
  key: CompanyWebsiteTemplateKey,
  content: CompanyWebsiteContent,
): ReactNode {
  return COMPANY_WEBSITE_TEMPLATES[key].render(content);
}
