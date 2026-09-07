/* eslint-disable @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access */
import { useEffect, useState, type SyntheticEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { platformApi, type WebsiteCmsBundle } from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";
import { platformConfiguration } from "../config/environment.js";
import { BlogRichEditor, blocksToHtml, plainBlogHtml, safeEditorHtml } from "./BlogRichEditor.js";
import { useBlogUnsavedWarning } from "./useBlogUnsavedWarning.js";
import { blogSavePayload as payload } from "./blog-save-payload.js";
import { BlogArticleImport } from "./BlogArticleImport.js";

const tabs = [
  "Overview",
  "Pages",
  "Pricing",
  "Features",
  "FAQs",
  "Help Center",
  "Blog",
  "Media",
  "SEO",
  "Contact & Social",
  "Navigation",
] as const;
const blankArticle = {
  slug: "",
  language: "en",
  translationGroupId: "",
  title: "",
  excerpt: "",
  content: "",
  authorId: "",
  categoryId: "",
  categoryIds: [],
  tagIds: [],
  relatedArticleIds: [],
  cornerstone: false,
  featuredImagePublicUrl: "",
  featuredImageAlt: "",
  featuredImageWidth: undefined,
  featuredImageHeight: undefined,
  seoTitle: "",
  metaDescription: "",
  canonicalUrl: "",
  robotsIndex: true,
  robotsFollow: true,
  socialTitle: "",
  socialDescription: "",
  socialImageUrl: "",
  socialImageAlt: "",
  socialImageWidth: undefined,
  socialImageHeight: undefined,
};
const label = (value: string) =>
  value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const publicWebBase = platformConfiguration.publicWebBaseUrl.replace(/\/$/, "");
const imageUrlPattern =
  /^(https:\/\/[^?#]+\.(?:jpe?g|png|webp)(?:[?#].*)?|\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+)$/i;
const slugify = (value: string) =>
  value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/^\/?(?:ar\/)?blog\//, "")
    .replace(/[^\p{L}\p{N}\p{M}-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
const articlePath = (slug: string, language = "en") =>
  `${language === "ar" ? "/ar" : ""}/blog/${slug || "article-slug"}`;
const articleUrl = (slug: string, language = "en") =>
  `${publicWebBase}${articlePath(slug, language)}`;
const helpPath = (slug: string) => `/resources/${slug || "guide-slug"}`;
const helpUrl = (slug: string) => `${publicWebBase}${helpPath(slug)}`;
const articleImageFallback = (slug: string) =>
  slug === "manage-cod-delivery-operations"
    ? `${publicWebBase}/blog-images/manage-cod-delivery-operations.jpg`
    : "";
const useArticleImageFallback = (event: SyntheticEvent<HTMLImageElement>, slug: string) => {
  const fallback = articleImageFallback(slug);
  if (!fallback || event.currentTarget.src === fallback) {
    event.currentTarget.remove();
    return;
  }
  event.currentTarget.src = fallback;
};
const validateImageUrl = (value: string) =>
  !value.trim() || imageUrlPattern.test(value.trim())
    ? ""
    : "Please select a valid image or enter a direct HTTPS image URL.";
const cmsMediaUrl = (value: string | undefined | null) => {
  const path = String(value ?? "").trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api/"))
    return `${platformConfiguration.apiBaseUrl.replace(/\/$/, "")}${path.replace(/^\/api\/v1/, "")}`;
  return path;
};
const articleToForm = (a: any) => ({
  ...a,
  authorId: a.author_id,
  categoryId: a.category_id,
  categoryIds: a.category_ids ?? [a.category_id],
  tagIds: a.tag_ids ?? [],
  relatedArticleIds: a.related_article_ids ?? [],
  cornerstone: Boolean(a.cornerstone),
  translationGroupId: a.translation_group_id ?? "",
  featuredImagePublicUrl: a.featured_image_public_url ?? "",
  featuredImageAlt: a.featured_image_alt ?? "",
  featuredImageWidth: a.featured_image_width ?? undefined,
  featuredImageHeight: a.featured_image_height ?? undefined,
  seoTitle: a.seo_title ?? "",
  metaDescription: a.meta_description ?? "",
  canonicalUrl: a.canonical_url ?? "",
  robotsIndex: a.robots_index,
  robotsFollow: a.robots_follow,
  socialTitle: a.social_title ?? "",
  socialDescription: a.social_description ?? "",
  socialImageUrl: a.social_image_url ?? "",
  socialImageAlt: a.social_image_alt ?? "",
  socialImageWidth: a.social_image_width ?? undefined,
  socialImageHeight: a.social_image_height ?? undefined,
  content: Array.isArray(a.content) ? blocksToHtml(a.content) : "",
});

export function WebsiteContentPage({ preview = false }: { preview?: boolean }) {
  const { id } = useParams();
  if (preview && id) return <BlogDraftPreview id={id} />;
  return id ? <BlogEditor id={id} /> : <WebsiteCms />;
}

function WebsiteCms() {
  const session = usePlatformSession(),
    [active, setActive] = useState<(typeof tabs)[number]>("Overview"),
    [data, setData] = useState<WebsiteCmsBundle>(),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const load = () =>
    void platformApi
      .websiteCms()
      .then(setData)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Website content could not be loaded."),
      );
  useEffect(load, []);
  const canManage = session.can("platform.website.manage"),
    canPublish = session.can("platform.website.publish");
  async function run(action: () => Promise<any>, done: string) {
    setError("");
    try {
      await action();
      setMessage(done);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved.");
    }
  }
  if (error && !data)
    return (
      <section className="platform-panel">
        <p role="alert">{error}</p>
        <button className="platform-button platform-button--quiet" onClick={load} type="button">
          Retry
        </button>
      </section>
    );
  if (!data)
    return (
      <section className="platform-panel">
        <p>Loading Website CMS…</p>
      </section>
    );
  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <div>
          <h2>Website</h2>
          <p className="platform-muted">
            Controlled public website content. Public workflows and business logic remain
            application-controlled.
          </p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p className="platform-success">{message}</p>}
      <div className="website-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            className={active === tab ? "active" : ""}
            key={tab}
            onClick={() => setActive(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      {active === "Overview" && <Overview data={data} />}{" "}
      {active === "Pages" && (
        <Pages data={data} canManage={canManage} canPublish={canPublish} run={run} />
      )}{" "}
      {active === "Pricing" && (
        <Pricing data={data} canManage={canManage} canPublish={canPublish} run={run} />
      )}{" "}
      {active === "Features" && (
        <Features data={data} run={run} canManage={canManage} canPublish={canPublish} />
      )}{" "}
      {active === "FAQs" && (
        <Faqs data={data} run={run} canManage={canManage} canPublish={canPublish} />
      )}{" "}
      {active === "Help Center" && (
        <HelpCenter data={data} run={run} canManage={canManage} canPublish={canPublish} />
      )}{" "}
      {active === "Blog" && <BlogList />} {active === "Media" && <Media data={data} run={run} />}{" "}
      {active === "SEO" && <SeoSettings />}{" "}
      {active === "Contact & Social" && (
        <Contact data={data} run={run} canManage={canManage} canPublish={canPublish} />
      )}{" "}
      {active === "Navigation" && <Navigation data={data} run={run} canManage={canManage} />}
    </section>
  );
}

function Overview({ data }: { data: WebsiteCmsBundle }) {
  const cards: [string, unknown][] = [
    ["Draft Pages", data.overview.draftPages],
    ["Published Pages", data.overview.publishedPages],
    ["Draft Blog Posts", data.overview.draftBlogPosts],
    ["Scheduled Posts", data.overview.scheduledPosts],
    ["Published Posts", data.overview.publishedPosts],
    ["Draft Help Articles", data.overview.draftHelpArticles],
    ["Published Help Articles", data.overview.publishedHelpArticles],
  ];
  return (
    <div className="cms-card-grid">
      {cards.map(([k, v]) => (
        <article key={k}>
          <span>{k}</span>
          <strong>{String(v ?? 0)}</strong>
        </article>
      ))}
      <article>
        <span>Controlled CMS scope</span>
        <p>
          No drag/drop builder, custom JavaScript, theme editor, API keys, billing logic, Agent
          logic, or operational workflows are editable here.
        </p>
      </article>
      <article>
        <span>Recent history</span>
        {data.revisions.slice(0, 5).map((x: any) => (
          <p key={`${x.entityType}-${x.entityKey}-${x.createdAt}`}>
            {label(x.eventType)} · {x.entityType} · {x.entityKey}
          </p>
        ))}
      </article>
    </div>
  );
}

function Pages({
  data,
  canManage,
  canPublish,
  run,
}: {
  data: WebsiteCmsBundle;
  canManage: boolean;
  canPublish: boolean;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
}) {
  const [row, setRow] = useState<any>(data.pages[0]);
  useEffect(() => setRow(data.pages[0]), [data.pages]);
  if (!row) return <p>No managed pages yet.</p>;
  const c = row.draft_content ?? {},
    hero = c.hero ?? {},
    seo = c.seo ?? {},
    set = (path: string, value: any) =>
      setRow((r: any) => {
        const n = {
          ...r,
          draft_content: {
            ...r.draft_content,
            hero: { ...hero },
            seo: { ...seo },
            pricingPreview: { ...(r.draft_content?.pricingPreview ?? {}) },
            requestDemoCta: { ...(r.draft_content?.requestDemoCta ?? {}) },
          },
        };
        const [group, key] = path.split(".");
        if (group && key) n.draft_content[group][key] = value;
        return n;
      });
  const input = {
    pageKey: row.page_key,
    locale: row.locale,
    visible: row.visible,
    heroEyebrow: hero.eyebrow ?? "",
    heroHeading: hero.heading ?? "",
    heroSubheading: hero.subheading ?? "",
    primaryCtaLabel: hero.primaryCtaLabel ?? "",
    primaryCtaUrl: hero.primaryCtaUrl ?? "/request-demo",
    secondaryCtaLabel: hero.secondaryCtaLabel ?? "",
    secondaryCtaUrl: hero.secondaryCtaUrl ?? "/send-a-package",
    pricingHeading: c.pricingPreview?.heading ?? "",
    pricingDescription: c.pricingPreview?.description ?? "",
    ctaHeading: c.requestDemoCta?.heading ?? "",
    ctaText: c.requestDemoCta?.text ?? "",
    ctaButtonLabel: c.requestDemoCta?.buttonLabel ?? "",
    seoTitle: seo.title ?? "",
    seoDescription: seo.description ?? "",
    canonicalPath: seo.canonical ?? "/",
    robotsIndex: seo.robotsIndex !== false,
    robotsFollow: seo.robotsFollow !== false,
    ogImage: seo.ogImage ?? undefined,
  };
  return (
    <div>
      <div className="platform-filters">
        <label>
          Page
          <select
            value={`${row.page_key}:${row.locale}`}
            onChange={(e) => {
              const [page, locale] = e.target.value.split(":");
              setRow(data.pages.find((x: any) => x.page_key === page && x.locale === locale));
            }}
          >
            {data.pages.map((x: any) => (
              <option key={`${x.page_key}:${x.locale}`} value={`${x.page_key}:${x.locale}`}>
                {x.page_key} · {x.locale}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="content-editor">
        <label>
          Hero eyebrow
          <input value={input.heroEyebrow} onChange={(e) => set("hero.eyebrow", e.target.value)} />
        </label>
        <label>
          Hero heading
          <input value={input.heroHeading} onChange={(e) => set("hero.heading", e.target.value)} />
        </label>
        <label>
          Hero subheading
          <textarea
            value={input.heroSubheading}
            onChange={(e) => set("hero.subheading", e.target.value)}
          />
        </label>
        <label>
          SEO title
          <input value={input.seoTitle} onChange={(e) => set("seo.title", e.target.value)} />
        </label>
        <label>
          Meta description
          <textarea
            value={input.seoDescription}
            onChange={(e) => set("seo.description", e.target.value)}
          />
        </label>
        <div className="publishing-actions">
          {canManage && (
            <button
              onClick={() =>
                run(
                  () => platformApi.saveWebsitePage(row.page_key, row.locale, input),
                  "Page draft saved.",
                )
              }
            >
              Save Draft
            </button>
          )}
          {canPublish && (
            <button
              onClick={() =>
                confirm("Publish these page changes to the public website?") &&
                run(
                  () => platformApi.publishWebsitePage(row.page_key, row.locale),
                  "Page published.",
                )
              }
            >
              Publish
            </button>
          )}
        </div>
      </div>
      <Preview title={input.heroHeading} copy={input.heroSubheading} />
    </div>
  );
}

function Pricing({
  data,
  canManage,
  canPublish,
  run,
}: {
  data: WebsiteCmsBundle;
  canManage: boolean;
  canPublish: boolean;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
}) {
  const [row, setRow] = useState<any>(data.pricing[0]);
  useEffect(() => setRow(data.pricing[0]), [data.pricing]);
  if (!row) return <p>No pricing plans yet.</p>;
  const d = row.draft_data ?? {},
    set = (k: string, v: any) =>
      setRow((r: any) => ({ ...r, draft_data: { ...r.draft_data, [k]: v } }));
  const input = {
    planKey: row.plan_key,
    locale: row.locale,
    name: d.name ?? "",
    price: Number(d.price ?? 0),
    currency: d.currency ?? "AED",
    period: d.period ?? "per month",
    minOrders: Number(d.minOrders ?? 0),
    maxOrders: d.maxOrders ?? null,
    volume: d.volume ?? "",
    description: d.description ?? "",
    highlights: Array.isArray(d.highlights) ? d.highlights : [],
    ctaLabel: d.ctaLabel ?? "Request Demo",
    ctaUrl: d.ctaUrl ?? "/request-demo",
    recommended: Boolean(d.recommended),
    active: row.active,
    sortOrder: row.sort_order,
  };
  return (
    <div>
      <div className="platform-filters">
        <label>
          Plan
          <select
            value={`${row.plan_key}:${row.locale}`}
            onChange={(e) => {
              const [plan, locale] = e.target.value.split(":");
              setRow(data.pricing.find((x: any) => x.plan_key === plan && x.locale === locale));
            }}
          >
            {data.pricing.map((x: any) => (
              <option key={`${x.plan_key}:${x.locale}`} value={`${x.plan_key}:${x.locale}`}>
                {x.plan_key} · {x.locale}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="content-editor">
        <label>
          Name
          <input value={input.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label>
          Price
          <input
            type="number"
            value={input.price}
            onChange={(e) => set("price", Number(e.target.value))}
          />
        </label>
        <label>
          Currency
          <input
            value={input.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
          />
        </label>
        <label>
          Min orders
          <input
            type="number"
            value={input.minOrders}
            onChange={(e) => set("minOrders", Number(e.target.value))}
          />
        </label>
        <label>
          Max orders
          <input
            type="number"
            value={input.maxOrders ?? ""}
            onChange={(e) =>
              set("maxOrders", e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </label>
        <label>
          Volume label
          <input value={input.volume} onChange={(e) => set("volume", e.target.value)} />
        </label>
        <label>
          Feature bullets
          <textarea
            value={input.highlights.join("\n")}
            onChange={(e) => set("highlights", e.target.value.split("\n").filter(Boolean))}
          />
        </label>
        <label>
          <input
            checked={input.recommended}
            type="checkbox"
            onChange={(e) => set("recommended", e.target.checked)}
          />{" "}
          Recommended
        </label>
        <div className="publishing-actions">
          {canManage && (
            <button
              onClick={() =>
                run(
                  () => platformApi.saveWebsitePricing(row.plan_key, row.locale, input),
                  "Pricing draft saved.",
                )
              }
            >
              Save Draft
            </button>
          )}
          {canPublish && (
            <button
              onClick={() =>
                confirm("Publish these pricing changes to the public website?") &&
                run(
                  () => platformApi.publishWebsitePricing(row.plan_key, row.locale),
                  "Pricing published.",
                )
              }
            >
              Publish
            </button>
          )}
        </div>
      </div>
      <Preview title={`${input.currency} ${input.price} · ${input.name}`} copy={input.volume} />
    </div>
  );
}

function Features({
  data,
  run,
  canManage,
  canPublish,
}: {
  data: WebsiteCmsBundle;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
  canManage: boolean;
  canPublish: boolean;
}) {
  const [form, setForm] = useState({
    slug: "cod-collections",
    locale: "en",
    name: "COD & Collections",
    shortDescription: "Controlled cash collection workflows.",
    fullDescription: "",
    audience: "delivery_company",
    category: "COD & Collections",
    featureStatus: "live",
    visible: true,
    sortOrder: 100,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="content-editor">
      <p className="platform-muted">
        Public-facing feature copy only. Operational availability is not controlled here.
      </p>
      <label>
        Feature name
        <input value={form.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label>
        Slug
        <input value={form.slug} onChange={(e) => set("slug", e.target.value)} />
      </label>
      <label>
        Short description
        <textarea
          value={form.shortDescription}
          onChange={(e) => set("shortDescription", e.target.value)}
        />
      </label>
      <label>
        Status
        <select value={form.featureStatus} onChange={(e) => set("featureStatus", e.target.value)}>
          {["live", "beta", "in_development", "planned", "not_available"].map((x) => (
            <option key={x} value={x}>
              {label(x)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.visible}
          onChange={(e) => set("visible", e.target.checked)}
        />{" "}
        Visible publicly
      </label>
      <div className="publishing-actions">
        {canManage && (
          <button
            onClick={() =>
              run(
                () => platformApi.saveWebsiteFeature(form.slug, form.locale, form),
                "Feature draft saved.",
              )
            }
          >
            Save Draft
          </button>
        )}
        {canPublish && (
          <button
            onClick={() =>
              run(
                () => platformApi.publishWebsiteFeature(form.slug, form.locale),
                "Feature published.",
              )
            }
          >
            Publish
          </button>
        )}
      </div>
      <Table
        rows={data.features}
        cols={["slug", "locale", "category", "feature_status", "status", "visible"]}
      />
    </div>
  );
}

function Faqs({
  data,
  run,
  canManage,
  canPublish,
}: {
  data: WebsiteCmsBundle;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
  canManage: boolean;
  canPublish: boolean;
}) {
  const [form, setForm] = useState({
    faqKey: "prompt-4-test",
    locale: "en",
    question: "How does Tawseelhub help delivery companies?",
    answer:
      "Tawseelhub helps delivery companies manage daily operations, drivers, COD, settlements and reports from one controlled system.",
    audience: "all",
    category: "general",
    visible: true,
    availableToAgent: false,
    sortOrder: 100,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="content-editor">
      <label>
        Question
        <input value={form.question} onChange={(e) => set("question", e.target.value)} />
      </label>
      <label>
        Answer
        <textarea value={form.answer} onChange={(e) => set("answer", e.target.value)} />
      </label>
      <label>
        Locale
        <select value={form.locale} onChange={(e) => set("locale", e.target.value)}>
          <option value="en">English</option>
          <option value="ar">Arabic</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.visible}
          onChange={(e) => set("visible", e.target.checked)}
        />{" "}
        Visible
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.availableToAgent}
          onChange={(e) => set("availableToAgent", e.target.checked)}
        />{" "}
        Available to Agent as public knowledge
      </label>
      <div className="publishing-actions">
        {canManage && (
          <button
            onClick={() =>
              run(
                () => platformApi.saveWebsiteFaq(form.faqKey, form.locale, form),
                "FAQ draft saved.",
              )
            }
          >
            Save Draft
          </button>
        )}
        {canPublish && (
          <button
            onClick={() =>
              run(() => platformApi.publishWebsiteFaq(form.faqKey, form.locale), "FAQ published.")
            }
          >
            Publish
          </button>
        )}
      </div>
      <Table
        rows={data.faqs}
        cols={["faq_key", "locale", "category", "status", "visible", "available_to_agent"]}
      />
    </div>
  );
}

function HelpCenter({
  data,
  run,
  canManage,
  canPublish,
}: {
  data: WebsiteCmsBundle;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
  canManage: boolean;
  canPublish: boolean;
}) {
  const firstCategory = data.helpCategories[0];
  const [category, setCategory] = useState<any>(
    firstCategory ?? {
      slug: "getting-started",
      locale: "en",
      name: "Getting Started",
      description: "Basic Tawseelhub guides.",
      audience: "all",
      icon: "compass",
      visible: true,
      sort_order: 10,
    },
  );
  const [article, setArticle] = useState<any>(
    data.helpArticles[0] ?? {
      slug: "new-help-guide",
      locale: "en",
      title: "New help guide",
      summary: "Short summary for the public Help Center.",
      body: [{ type: "paragraph", text: "Write the guide content here." }],
      category_slug: firstCategory?.slug ?? "getting-started",
      audience: "all",
      featured: false,
      available_to_agent: false,
      related_slugs: [],
      sort_order: 100,
      seo_title: "New help guide | Tawseelhub Help Center",
      meta_description: "Short SEO description for this Tawseelhub help guide.",
      canonical_path: "/resources/new-help-guide",
      robots_index: true,
      robots_follow: true,
    },
  );
  useEffect(() => {
    if (data.helpCategories[0]) setCategory(data.helpCategories[0]);
    if (data.helpArticles[0]) setArticle(data.helpArticles[0]);
  }, [data.helpCategories, data.helpArticles]);
  const setCat = (k: string, v: any) => setCategory((c: any) => ({ ...c, [k]: v }));
  const setArt = (k: string, v: any) => setArticle((a: any) => ({ ...a, [k]: v }));
  const bodyText = Array.isArray(article.body)
    ? article.body
        .map((block: any) =>
          block.type === "bullet_list" || block.type === "numbered_list"
            ? (block.items ?? []).join("\n")
            : (block.text ?? ""),
        )
        .join("\n\n")
    : "";
  const articleInput = {
    slug: article.slug,
    locale: article.locale,
    title: article.title,
    summary: article.summary,
    body: String(bodyText)
      .split(/\n\n+/)
      .filter(Boolean)
      .map((text: string) =>
        text.includes("\n")
          ? { type: "bullet_list", items: text.split("\n").filter(Boolean) }
          : { type: "paragraph", text },
      ),
    categorySlug: article.category_slug ?? category.slug,
    audience: article.audience,
    featured: Boolean(article.featured),
    availableToAgent: Boolean(article.available_to_agent),
    relatedSlugs: Array.isArray(article.related_slugs) ? article.related_slugs : [],
    sortOrder: Number(article.sort_order ?? 100),
    seoTitle: article.seo_title ?? article.title,
    metaDescription: article.meta_description ?? article.summary,
    canonicalPath: article.canonical_path ?? helpPath(article.slug),
    robotsIndex: article.robots_index !== false,
    robotsFollow: article.robots_follow !== false,
    ogTitle: article.og_title ?? "",
    ogDescription: article.og_description ?? "",
    ogImage: article.og_image ?? undefined,
  };
  const categoryInput = {
    slug: category.slug,
    locale: category.locale,
    name: category.name,
    description: category.description ?? "",
    audience: category.audience ?? "all",
    icon: category.icon ?? "",
    visible: category.visible !== false,
    sortOrder: Number(category.sort_order ?? 100),
  };
  return (
    <div>
      <div className="platform-panel__header">
        <div>
          <h3>Help Center</h3>
          <p className="platform-muted">
            Manage public guides for /resources. Draft articles are private until published.
          </p>
        </div>
        <a
          className="platform-button"
          href={`${publicWebBase}/resources`}
          target="_blank"
          rel="noreferrer"
        >
          Open Help Center
        </a>
      </div>
      <div className="content-editor">
        <h3>Category</h3>
        <label>
          Choose category
          <select
            value={`${category.slug}:${category.locale}`}
            onChange={(e) => {
              const [slug, locale] = e.target.value.split(":");
              setCategory(
                data.helpCategories.find((x: any) => x.slug === slug && x.locale === locale),
              );
            }}
          >
            {data.helpCategories.map((x: any) => (
              <option key={`${x.slug}:${x.locale}`} value={`${x.slug}:${x.locale}`}>
                {x.name} · {x.locale}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input value={categoryInput.name} onChange={(e) => setCat("name", e.target.value)} />
        </label>
        <label>
          Description
          <textarea
            value={categoryInput.description}
            onChange={(e) => setCat("description", e.target.value)}
          />
        </label>
        <label>
          Audience
          <select
            value={categoryInput.audience}
            onChange={(e) => setCat("audience", e.target.value)}
          >
            {["all", "delivery_company", "trader", "customer", "integration_developer"].map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={categoryInput.visible}
            onChange={(e) => setCat("visible", e.target.checked)}
          />{" "}
          Visible
        </label>
        {canManage && (
          <button
            onClick={() =>
              run(
                () => platformApi.saveHelpCategory(category.slug, category.locale, categoryInput),
                "Help category saved.",
              )
            }
          >
            Save Category
          </button>
        )}
        <h3>Article</h3>
        <label>
          Choose article
          <select
            value={`${article.slug}:${article.locale}`}
            onChange={(e) => {
              const [slug, locale] = e.target.value.split(":");
              setArticle(
                data.helpArticles.find((x: any) => x.slug === slug && x.locale === locale),
              );
            }}
          >
            {data.helpArticles.map((x: any) => (
              <option key={`${x.slug}:${x.locale}`} value={`${x.slug}:${x.locale}`}>
                {x.title} · {x.locale} · {x.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input value={articleInput.title} onChange={(e) => setArt("title", e.target.value)} />
        </label>
        <label>
          Slug
          <input
            value={articleInput.slug}
            onChange={(e) => setArt("slug", slugify(e.target.value))}
          />
          <small>Public URL: {helpPath(articleInput.slug)}</small>
        </label>
        <label>
          Summary
          <textarea
            value={articleInput.summary}
            onChange={(e) => setArt("summary", e.target.value)}
          />
        </label>
        <label>
          Body — separate paragraphs with a blank line
          <textarea
            rows={12}
            value={bodyText}
            onChange={(e) =>
              setArt(
                "body",
                e.target.value
                  .split(/\n\n+/)
                  .filter(Boolean)
                  .map((text) => ({ type: "paragraph", text })),
              )
            }
          />
        </label>
        <div className="platform-filters">
          <label>
            Category
            <select
              value={articleInput.categorySlug}
              onChange={(e) => setArt("category_slug", e.target.value)}
            >
              {data.helpCategories
                .filter((x: any) => x.locale === article.locale)
                .map((x: any) => (
                  <option key={x.slug} value={x.slug}>
                    {x.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Locale
            <select value={articleInput.locale} onChange={(e) => setArt("locale", e.target.value)}>
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>
          </label>
          <label>
            Audience
            <select
              value={articleInput.audience}
              onChange={(e) => setArt("audience", e.target.value)}
            >
              {["all", "delivery_company", "trader", "customer", "integration_developer"].map(
                (x) => (
                  <option key={x} value={x}>
                    {label(x)}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            checked={articleInput.featured}
            onChange={(e) => setArt("featured", e.target.checked)}
          />{" "}
          Featured on Help Center
        </label>
        <label>
          <input
            type="checkbox"
            checked={articleInput.availableToAgent}
            onChange={(e) => setArt("available_to_agent", e.target.checked)}
          />{" "}
          Available to Yousef as public knowledge
        </label>
        <label>
          SEO title
          <input
            value={articleInput.seoTitle}
            onChange={(e) => setArt("seo_title", e.target.value)}
          />
        </label>
        <label>
          Meta description
          <textarea
            value={articleInput.metaDescription}
            onChange={(e) => setArt("meta_description", e.target.value)}
          />
        </label>
        <div className="publishing-actions">
          {canManage && (
            <button
              onClick={() =>
                run(
                  () => platformApi.saveHelpArticle(article.slug, article.locale, articleInput),
                  "Help article draft saved.",
                )
              }
            >
              Save Draft
            </button>
          )}
          {canPublish && (
            <button
              onClick={() =>
                confirm("Publish this help article to the public website?") &&
                run(
                  () => platformApi.publishHelpArticle(article.slug, article.locale),
                  "Help article published.",
                )
              }
            >
              Publish
            </button>
          )}
          {canPublish && (
            <button
              onClick={() =>
                confirm("Archive this help article? The public URL will stop working.") &&
                run(
                  () => platformApi.archiveHelpArticle(article.slug, article.locale),
                  "Help article archived.",
                )
              }
            >
              Archive
            </button>
          )}
          <a
            className="platform-button"
            href={helpUrl(article.slug)}
            target="_blank"
            rel="noreferrer"
          >
            Open Published Guide
          </a>
        </div>
        <Table
          rows={data.helpArticles}
          cols={[
            "slug",
            "locale",
            "category_slug",
            "audience",
            "status",
            "featured",
            "available_to_agent",
          ]}
        />
      </div>
    </div>
  );
}

function Media({
  data,
  run,
}: {
  data: WebsiteCmsBundle;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null),
    [alt, setAlt] = useState("Website image");
  return (
    <div>
      <div className="content-editor">
        <label>
          Image file
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          Alt text
          <input value={alt} onChange={(e) => setAlt(e.target.value)} />
        </label>
        <button
          disabled={!file}
          onClick={() =>
            file &&
            run(() => platformApi.uploadWebsiteMedia(file, { altText: alt }), "Media uploaded.")
          }
        >
          Upload Image
        </button>
      </div>
      <div className="media-grid">
        {data.media.map((x: any) => (
          <article key={x.publicUrl}>
            <img alt={x.altText} src={cmsMediaUrl(x.publicUrl)} />
            <strong>{x.altText}</strong>
            <small>
              {x.mediaType} · {x.sizeBytes} bytes
            </small>
          </article>
        ))}
      </div>
    </div>
  );
}

function Contact({
  data,
  run,
  canManage,
  canPublish,
}: {
  data: WebsiteCmsBundle;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
  canManage: boolean;
  canPublish: boolean;
}) {
  const [form, setForm] = useState<any>(
      data.contact?.draft_data ?? {
        publicPhone: "+971 50 689 8604",
        whatsapp: "+971 50 689 8604",
        supportEmail: "hello@tawseelhub.com",
      },
    ),
    set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  return (
    <div className="content-editor">
      <label>
        Public phone
        <input
          value={form.publicPhone ?? ""}
          onChange={(e) => set("publicPhone", e.target.value)}
        />
      </label>
      <label>
        WhatsApp
        <input value={form.whatsapp ?? ""} onChange={(e) => set("whatsapp", e.target.value)} />
      </label>
      <label>
        Support email
        <input
          value={form.supportEmail ?? ""}
          onChange={(e) => set("supportEmail", e.target.value)}
        />
      </label>
      <label>
        LinkedIn
        <input value={form.linkedin ?? ""} onChange={(e) => set("linkedin", e.target.value)} />
      </label>
      <div className="publishing-actions">
        {canManage && (
          <button
            onClick={() => run(() => platformApi.saveWebsiteContact(form), "Contact draft saved.")}
          >
            Save Draft
          </button>
        )}
        {canPublish && (
          <button
            onClick={() =>
              run(() => platformApi.publishWebsiteContact(), "Contact settings published.")
            }
          >
            Publish
          </button>
        )}
      </div>
    </div>
  );
}

function Navigation({
  data,
  run,
  canManage,
}: {
  data: WebsiteCmsBundle;
  run: (a: () => Promise<any>, d: string) => Promise<void>;
  canManage: boolean;
}) {
  const [row, setRow] = useState<any>(data.navigation[0]);
  useEffect(() => setRow(data.navigation[0]), [data.navigation]);
  if (!row) return <p>No navigation items.</p>;
  const set = (k: string, v: any) => setRow((r: any) => ({ ...r, [k]: v }));
  return (
    <div>
      <div className="platform-filters">
        <label>
          Navigation item
          <select
            value={`${row.item_key}:${row.locale}`}
            onChange={(e) => {
              const [key, locale] = e.target.value.split(":");
              setRow(data.navigation.find((x: any) => x.item_key === key && x.locale === locale));
            }}
          >
            {data.navigation.map((x: any) => (
              <option key={`${x.item_key}:${x.locale}`} value={`${x.item_key}:${x.locale}`}>
                {x.item_key} · {x.locale}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="content-editor">
        <label>
          Label
          <input value={row.label} onChange={(e) => set("label", e.target.value)} />
        </label>
        <label>
          Destination
          <select value={row.destination} onChange={(e) => set("destination", e.target.value)}>
            {[
              "/delivery-companies",
              "/send-a-package",
              "/traders",
              "/pricing",
              "/blog",
              "/request-demo",
              "/contact",
            ].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={row.visible}
            onChange={(e) => set("visible", e.target.checked)}
          />{" "}
          Visible
        </label>
        {canManage && (
          <button
            onClick={() =>
              run(
                () =>
                  platformApi.saveWebsiteNavigation(row.item_key, row.locale, {
                    itemKey: row.item_key,
                    locale: row.locale,
                    label: row.label,
                    destination: row.destination,
                    visible: row.visible,
                    sortOrder: row.sort_order,
                  }),
                "Navigation saved.",
              )
            }
          >
            Save Navigation
          </button>
        )}
      </div>
    </div>
  );
}

function SeoSettings() {
  return <Settings />;
}
function Preview({ title, copy }: { title: string; copy: string }) {
  return (
    <article className="cms-preview">
      <span>Safe preview</span>
      <h3>{title}</h3>
      <p>{copy}</p>
    </article>
  );
}
function Table({ rows, cols }: { rows: any[]; cols: string[] }) {
  return (
    <div className="platform-table-scroll">
      <table className="platform-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{label(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {cols.map((c) => (
                <td key={c}>{String(r[c] ?? "—")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlogList() {
  const [rows, setRows] = useState<any[]>([]),
    session = usePlatformSession();
  useEffect(() => {
    void platformApi.blogArticles().then(setRows);
  }, []);
  return (
    <div>
      <div className="platform-panel__header">
        <div>
          <h3>Blog</h3>
          <p className="platform-muted">
            Create, edit, draft, publish, schedule, unpublish and archive blog articles.
          </p>
        </div>
        {session.can("platform.blog.create") && (
          <Link className="platform-button" to="/website/new">
            New article
          </Link>
        )}
        <Link className="platform-button platform-button--quiet" to="/website/editorial-seo">
          Editorial SEO
        </Link>
      </div>
      <div className="platform-table-scroll">
        <table className="platform-table">
          <thead>
            <tr>
              {[
                "title",
                "language",
                "category",
                "status",
                "has_unpublished_changes",
                "published_at",
                "scheduled_at",
                "updated_at",
              ].map((c) => (
                <th key={c}>{label(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to={`/website/${row.id}`}>{row.title}</Link>
                </td>
                <td>{row.language}</td>
                <td>{row.category}</td>
                <td>{row.status}</td>
                <td>{String(row.has_unpublished_changes ?? false)}</td>
                <td>{row.published_at ?? "—"}</td>
                <td>{row.scheduled_at ?? "—"}</td>
                <td>{row.updated_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BlogEditor({ id }: { id: string }) {
  const session = usePlatformSession(),
    [form, setForm] = useState<any>(blankArticle),
    [refs, setRefs] = useState<any>({ categories: [], authors: [] }),
    [media, setMedia] = useState<any[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [slugEdited, setSlugEdited] = useState(false),
    [imageFailed, setImageFailed] = useState(false),
    [uploadFile, setUploadFile] = useState<File | null>(null),
    isNew = id === "new";
  const [busy, setBusy] = useState(false),
    [savedSnapshot, setSavedSnapshot] = useState("");
  const dirty = savedSnapshot !== JSON.stringify(form);
  useBlogUnsavedWarning(!busy && dirty);
  const acceptSaved = (article: any) => {
    const loaded = articleToForm(article);
    setForm(loaded);
    setSavedSnapshot(JSON.stringify(loaded));
  };
  const saveMessage = (article: any, fallback: string) => {
    const warnings = Array.isArray(article?.editorWarnings) ? article.editorWarnings : [];
    return warnings.length ? warnings.join(" ") : fallback;
  };
  useEffect(() => {
    void Promise.all([platformApi.blogReferences(), platformApi.blogArticles()]).then(
      ([r, articles]) => {
        setRefs({ ...r, articles });
        if (isNew)
          setForm((f: any) => ({
            ...f,
            authorId: r.authors[0]?.id ?? "",
            categoryId: r.categories.find((c: any) => c.language === f.language)?.id ?? "",
          }));
      },
    );
    void platformApi.websiteCms().then((d) => setMedia(d.media ?? []));
    if (!isNew)
      void platformApi
        .blogArticle(id)
        .then(acceptSaved)
        .catch((e) => setError(e instanceof Error ? e.message : "Article could not be loaded."));
  }, [id, isNew]);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const publicPath = articlePath(form.slug, form.language);
  const publicUrl = articleUrl(form.slug, form.language);
  const imageError = validateImageUrl(form.featuredImagePublicUrl ?? "");
  const canOpenPublished = !isNew && form.status === "published";
  const canPreview = !isNew;
  const draftNote = form.has_unpublished_changes
    ? `You have draft changes that are not public yet.${form.status === "published" ? " The public website is still showing the previously published version." : ""}`
    : "";
  const persistDraft = async () => {
    const normalizedSlug = slugify(form.slug);
    if (!normalizedSlug)
      throw new Error("Slug is required. Use lowercase letters, numbers and hyphens only.");
    if (imageError) throw new Error(imageError);
    return isNew
      ? platformApi.createBlogArticle(payload({ ...form, slug: normalizedSlug }))
      : platformApi.updateBlogArticle(id, payload({ ...form, slug: normalizedSlug }));
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await persistDraft();
      acceptSaved(saved);
      setMessage(saveMessage(saved, "Draft saved. Your text and formatting are saved."));
      if (isNew) location.assign(`/website/${saved.id}`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Save failed. Your changes are still in this editor.",
      );
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    if (busy) return;
    if (
      form.language === "ar" &&
      (!form.seoTitle.trim() || !form.metaDescription.trim()) &&
      !confirm(
        "Arabic SEO title or meta description is missing. Publish using the Arabic title/excerpt fallback?",
      )
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // Publish the current editor, never silently publish an older saved draft.
      if (dirty) {
        const draft = await persistDraft();
        acceptSaved(draft);
      }
      const saved = await platformApi.updateBlogArticleStatus(id, { status: "published" });
      acceptSaved(saved);
      setMessage(saveMessage(saved, "Current changes saved and published."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save or publish failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const changeStatus = async (status: string) => {
    setError("");
    try {
      const saved = await platformApi.updateBlogArticleStatus(id, { status });
      acceptSaved(saved);
      setMessage(
        status === "unpublished"
          ? "Article unpublished. The public URL is no longer available."
          : `Article ${label(status).toLowerCase()}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status change failed");
    }
  };
  const uploadImage = async () => {
    if (!uploadFile) return;
    setError("");
    try {
      const uploaded = await platformApi.uploadWebsiteMedia(uploadFile, {
        altText: form.featuredImageAlt || "Blog featured image",
      });
      setForm((f: any) => ({
        ...f,
        featuredImagePublicUrl: uploaded.publicUrl,
        featuredImageAlt: uploaded.altText || f.featuredImageAlt,
        featuredImageWidth: uploaded.width,
        featuredImageHeight: uploaded.height,
      }));
      setImageFailed(false);
      setMessage("Image uploaded and selected.");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Please select a valid image or enter a direct HTTPS image URL.",
      );
    }
  };
  return (
    <section className="platform-panel">
      <Link to="/website">← Website</Link>
      <h2>{isNew ? "New Blog Article" : form.title || "Edit Article"}</h2>
      <p className="platform-muted">
        Each language is an independently published article. Link the matching translation below;
        an unpublished translation never creates a public URL or hreflang.
      </p>
      <div className="blog-save-bar">
        <strong role="status">
          {busy
            ? "Saving…"
            : dirty
              ? "Unsaved changes — click Save Draft before leaving"
              : "All changes saved"}
        </strong>
        <button
          type="button"
          className="platform-button"
          disabled={busy}
          onClick={() => void save()}
        >
          Save Draft
        </button>
        {!isNew && session.can("platform.blog.publish") && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              confirm("Save current changes and publish this article?") && void publish()
            }
          >
            Save &amp; Publish
          </button>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p>{message}</p>}
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p className="platform-success">{message}</p>}
      {draftNote && (
        <div className="platform-success cms-draft-banner">
          <p>{draftNote}</p>
          <div className="publishing-actions">
            <button
              type="button"
              disabled={!canPreview}
              onClick={() => window.open(`/website/${id}/preview`, "_blank", "noopener,noreferrer")}
            >
              Preview Draft
            </button>
            {session.can("platform.blog.publish") && (
              <button
                type="button"
                onClick={() =>
                  confirm("Publish this blog article to the public website?") && void publish()
                }
              >
                Publish
              </button>
            )}
          </div>
        </div>
      )}
      {session.can("platform.blog.create") && (
        <BlogArticleImport
          key={id}
          current={form}
          authors={refs.authors}
          categories={refs.categories}
          onApply={(fields) => {
            setForm((previous: any) => ({
              ...previous,
              ...fields,
              ...(fields.content ? { content: plainBlogHtml(fields.content) } : {}),
            }));
            if (fields.slug) setSlugEdited(true);
            setMessage(
              "Imported fields applied. Review author, category and image, then choose Save Draft when ready.",
            );
          }}
        />
      )}
      <fieldset className="content-editor blog-editor-fields" disabled={busy}>
        <h3>{form.language === "ar" ? "Arabic content and SEO" : "English content and SEO"}</h3>
        <label>
          Title
          <input
            value={form.title}
            onChange={(e) => {
              const title = e.target.value;
              set("title", title);
              if (isNew && !slugEdited) set("slug", slugify(title));
            }}
          />
        </label>
        <label>
          Slug
          <input
            value={form.slug}
            onChange={(e) => {
              setSlugEdited(true);
              set("slug", slugify(e.target.value));
            }}
          />
          <small>
            Use a single safe URL segment. Arabic letters are supported; slashes, query strings,
            fragments and control characters are not.
          </small>
        </label>
        <div className="cms-url-row">
          <strong>Article URL</strong>
          <code>{publicPath}</code>
          <a href={publicUrl} target="_blank" rel="noreferrer">
            {publicUrl}
          </a>
        </div>
        <div className="publishing-actions">
          <button
            type="button"
            disabled={!canPreview}
            onClick={() => window.open(`/website/${id}/preview`, "_blank", "noopener,noreferrer")}
          >
            Preview Draft
          </button>
          {canOpenPublished ? (
            <button
              type="button"
              onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}
            >
              Open Published Article
            </button>
          ) : (
            <button type="button" disabled>
              Open Published Article
            </button>
          )}
        </div>
        <label>
          Excerpt
          <textarea value={form.excerpt} onChange={(e) => set("excerpt", e.target.value)} />
        </label>
        <BlogRichEditor
          disabled={busy}
          value={form.content}
          onChange={(html) => set("content", html)}
        />
        <div className="platform-filters">
          <label>
            Author
            <select value={form.authorId} onChange={(e) => set("authorId", e.target.value)}>
              {refs.authors.map((x: any) => (
                <option key={x.id} value={x.id}>
                  {x.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
              {refs.categories.filter((x: any) => x.language === form.language).map((x: any) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Additional categories
            <select
              multiple
              value={form.categoryIds.filter((categoryId: string) => categoryId !== form.categoryId)}
              onChange={(e) =>
                set("categoryIds", [
                  form.categoryId,
                  ...Array.from(e.currentTarget.selectedOptions, (option) => option.value),
                ])
              }
            >
              {refs.categories
                .filter((x: any) => x.language === form.language && x.id !== form.categoryId)
                .map((x: any) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
            <small>The primary category above controls breadcrumbs and article schema.</small>
          </label>
          <label>
            Tags
            <select
              multiple
              value={form.tagIds}
              onChange={(e) =>
                set(
                  "tagIds",
                  Array.from(e.currentTarget.selectedOptions, (option) => option.value),
                )
              }
            >
              {(refs.tags ?? [])
                .filter((x: any) => x.language === form.language && x.active)
                .map((x: any) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Language
            <select
              value={form.language}
              onChange={(e) => {
                const language = e.target.value;
                setForm((current: any) => ({
                  ...current,
                  language,
                  categoryId:
                    refs.categories.find((category: any) => category.language === language)?.id ?? "",
                }));
              }}
            >
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>
          </label>
          <label>
            Matching translation
            <select
              value={form.translationGroupId}
              onChange={(e) => set("translationGroupId", e.target.value)}
            >
              <option value={form.translationGroupId || ""}>No matching translation selected</option>
              {(refs.articles ?? [])
                .filter((article: any) => article.id !== id && article.language !== form.language)
                .map((article: any) => (
                  <option key={article.id} value={article.translation_group_id}>
                    {article.language === "ar" ? "Arabic" : "English"}: {article.title} ({article.status})
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            checked={form.cornerstone}
            onChange={(e) => set("cornerstone", e.target.checked)}
          />{" "}
          Cornerstone / pillar content
        </label>
        <label>
          Related articles (editorial override)
          <select
            multiple
            value={form.relatedArticleIds}
            onChange={(e) =>
              set(
                "relatedArticleIds",
                Array.from(e.currentTarget.selectedOptions, (option) => option.value),
              )
            }
          >
            {(refs.articles ?? [])
              .filter((x: any) => x.id !== id && x.language === form.language)
              .map((x: any) => (
                <option key={x.id} value={x.id}>
                  {x.cornerstone ? "★ " : ""}
                  {x.title}
                </option>
              ))}
          </select>
          <small>
            Choose only genuinely relevant content. Suggestions prioritize cornerstone and
            same-category articles.
          </small>
          <span className="platform-muted">Suggested internal links:</span>
          {(refs.articles ?? [])
            .filter(
              (article: any) =>
                article.id !== id &&
                article.language === form.language &&
                (article.cornerstone || article.category_id === form.categoryId),
            )
            .slice(0, 5)
            .map((article: any) => (
              <button
                type="button"
                key={`suggestion-${article.id}`}
                disabled={form.relatedArticleIds.includes(article.id)}
                onClick={() =>
                  set("relatedArticleIds", [...form.relatedArticleIds, article.id])
                }
              >
                {article.cornerstone ? "Cornerstone: " : "Related: "}
                {article.title}
              </button>
            ))}
        </label>
        {form.language === "ar" && (!form.title.trim() || !form.slug.trim() || !form.content.trim()) && (
          <p className="platform-warning">
            Arabic title, body and slug are required before this language version can be published.
          </p>
        )}
        <h3>Featured image</h3>
        <div className="publishing-actions">
          <label className="platform-inline-field">
            Choose from Media
            <select
              value=""
              onChange={(e) => {
                const selected = media.find((x: any) => x.publicUrl === e.target.value);
                if (selected) {
                  setForm((f: any) => ({
                    ...f,
                    featuredImagePublicUrl: selected.publicUrl,
                    featuredImageAlt: selected.altText ?? f.featuredImageAlt,
                    featuredImageWidth: selected.width,
                    featuredImageHeight: selected.height,
                  }));
                  setImageFailed(false);
                }
              }}
            >
              <option value="">Select media…</option>
              {media.map((x: any) => (
                <option key={x.publicUrl} value={x.publicUrl}>
                  {x.altText || x.originalFilename}
                </option>
              ))}
            </select>
          </label>
          <label className="platform-inline-field">
            Upload Image
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button type="button" disabled={!uploadFile} onClick={() => void uploadImage()}>
            Upload Image
          </button>
        </div>
        <label>
          HTTPS or CMS image URL
          <input
            value={form.featuredImagePublicUrl}
            onChange={(e) => {
              set("featuredImagePublicUrl", e.target.value.trim());
              setImageFailed(false);
            }}
          />
        </label>
        {imageError && <p role="alert">{imageError}</p>}
        {form.featuredImagePublicUrl && !imageError ? (
          <div className="cms-image-preview">
            {imageFailed ? (
              <p>Image could not be loaded.</p>
            ) : (
              <img
                src={cmsMediaUrl(form.featuredImagePublicUrl)}
                alt={form.featuredImageAlt || ""}
                onError={() => setImageFailed(true)}
              />
            )}
          </div>
        ) : null}
        <label>
          Image alt text
          <input
            value={form.featuredImageAlt}
            onChange={(e) => set("featuredImageAlt", e.target.value)}
          />
          <small>Describe the image for accessibility and search engines.</small>
        </label>
        <h3>SEO preview</h3>
        <SeoReadiness form={form} articles={refs.articles ?? []} />
        <a
          className="seo-preview seo-preview--link"
          href={canOpenPublished ? publicUrl : `/website/${id}/preview`}
          target="_blank"
          rel="noreferrer"
        >
          <strong>{form.seoTitle || form.title || "Article title"}</strong>
          <span>{canOpenPublished ? publicUrl : `Draft preview · ${publicPath}`}</span>
          <p>{form.metaDescription || form.excerpt || "Add a concise description."}</p>
        </a>
        <label>
          SEO title
          <input value={form.seoTitle} onChange={(e) => set("seoTitle", e.target.value)} />
        </label>
        <label>
          Meta description
          <textarea
            value={form.metaDescription}
            onChange={(e) => set("metaDescription", e.target.value)}
          />
        </label>
        <h3>Social Sharing</h3>
        <label>
          Social title (optional)
          <input value={form.socialTitle} onChange={(e) => set("socialTitle", e.target.value)} />
          <small>
            {form.socialTitle
              ? "Using social title override"
              : "Using SEO title, then article title"}
            {form.socialTitle.length > 100 ? " · Consider shortening for sharing." : ""}
          </small>
        </label>
        <label>
          Social description (optional)
          <textarea
            value={form.socialDescription}
            onChange={(e) => set("socialDescription", e.target.value)}
          />
          <small>
            {form.socialDescription
              ? "Using social description override"
              : "Using meta description, then excerpt"}
            {form.socialDescription.length > 240 ? " · Consider shortening for sharing." : ""}
          </small>
        </label>
        <label>
          Choose social image from Media
          <select
            value=""
            onChange={(e) => {
              const selected = media.find((x: any) => x.publicUrl === e.target.value);
              if (selected)
                setForm((f: any) => ({
                  ...f,
                  socialImageUrl: selected.publicUrl,
                  socialImageAlt: selected.altText ?? "",
                  socialImageWidth: selected.width,
                  socialImageHeight: selected.height,
                }));
            }}
          >
            <option value="">Select media…</option>
            {media.map((x: any) => (
              <option key={`social-${x.publicUrl}`} value={x.publicUrl}>
                {x.altText || x.originalFilename}
              </option>
            ))}
          </select>
        </label>
        <label>
          Social image URL (optional)
          <input
            value={form.socialImageUrl}
            onChange={(e) => set("socialImageUrl", e.target.value.trim())}
          />
          <small>
            {form.socialImageUrl ? "Using separate social image" : "Using featured image"}
          </small>
        </label>
        <label>
          Social image alt text
          <input
            value={form.socialImageAlt}
            onChange={(e) => set("socialImageAlt", e.target.value)}
          />
        </label>
        {(form.socialImageUrl || form.featuredImagePublicUrl) && (
          <article className="seo-preview social-preview">
            <img
              src={cmsMediaUrl(form.socialImageUrl || form.featuredImagePublicUrl)}
              alt={form.socialImageAlt || form.featuredImageAlt || ""}
            />
            <span>tawseelhub.com</span>
            <strong>{form.socialTitle || form.seoTitle || form.title || "Article title"}</strong>
            <p>
              {form.socialDescription ||
                form.metaDescription ||
                form.excerpt ||
                "Article description"}
            </p>
            <small>Approximate Open Graph / X large-image preview</small>
          </article>
        )}
        {form.featuredImagePublicUrl && !form.featuredImageAlt && (
          <p className="platform-warning">
            Warning: featured image is missing descriptive alt text.
          </p>
        )}
        {form.socialImageUrl && !form.socialImageAlt && (
          <p className="platform-warning">
            Warning: the separate social image is missing alt text.
          </p>
        )}
        <label>
          <input
            type="checkbox"
            checked={form.robotsIndex}
            onChange={(e) => set("robotsIndex", e.target.checked)}
          />{" "}
          Index
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.robotsFollow}
            onChange={(e) => set("robotsFollow", e.target.checked)}
          />{" "}
          Follow
        </label>
        <button className="platform-button" onClick={() => void save()}>
          Save Draft
        </button>
        {!isNew && session.can("platform.blog.publish") && (
          <div className="publishing-actions">
            <button
              onClick={() =>
                confirm("Publish this blog article to the public website?") && void publish()
              }
            >
              Publish
            </button>
            <button onClick={() => void changeStatus("unpublished")}>Unpublish</button>
            <button
              type="button"
              disabled={form.status !== "unpublished"}
              title={
                form.status !== "unpublished"
                  ? "Unpublish this article first"
                  : "Remove this article from the Blog list"
              }
              onClick={() => {
                if (
                  confirm(
                    `Delete “${form.title}” from the Blog list? Content and history are retained for recovery; shared images will not be deleted.`,
                  )
                )
                  void platformApi
                    .deleteBlogArticle(id)
                    .then(() => location.assign("/website"))
                    .catch((e) => setError(e instanceof Error ? e.message : "Delete failed"));
              }}
            >
              Delete article
            </button>
            <button onClick={() => void changeStatus("archived")}>Archive</button>
            <label>
              Schedule
              <input
                type="datetime-local"
                onChange={(e) => set("scheduledAt", new Date(e.target.value).toISOString())}
              />
            </label>
            <button
              onClick={() =>
                void platformApi
                  .updateBlogArticleStatus(id, {
                    status: "scheduled",
                    scheduledAt: form.scheduledAt,
                  })
                  .then((a) => setForm(articleToForm(a)))
                  .then(() => setMessage("Article scheduled."))
              }
            >
              Schedule
            </button>
          </div>
        )}
      </fieldset>
    </section>
  );
}

function SeoReadiness({ form, articles }: { form: any; articles: any[] }) {
  const body = String(form.content ?? "");
  const duplicateTitle = Boolean(form.seoTitle && articles.some((article) => article.id !== form.id && article.language === form.language && article.status === "published" && String(article.seo_title ?? "").toLocaleLowerCase() === form.seoTitle.toLocaleLowerCase()));
  const checks = [
    ["SEO title", Boolean(form.seoTitle), "warning"],
    ["Unique SEO title", !duplicateTitle, "warning"],
    ["Meta description", Boolean(form.metaDescription), "warning"],
    ["Featured image", Boolean(form.featuredImagePublicUrl), "warning"],
    ["Image alt", !form.featuredImagePublicUrl || Boolean(form.featuredImageAlt), "warning"],
    ["Author", Boolean(form.authorId), "blocking"],
    ["Primary category", Boolean(form.categoryId), "blocking"],
    ["Internal or related link", /href\s*=/.test(body) || form.relatedArticleIds.length > 0, "warning"],
    ["Canonical", !form.canonicalUrl || form.canonicalUrl === articleUrl(form.slug, form.language), "blocking"],
    ["Arabic metadata", form.language !== "ar" || Boolean(form.title && form.slug && body && form.seoTitle && form.metaDescription && form.translationGroupId), "warning"],
  ] as const;
  const status = checks.some(([, pass, severity]) => !pass && severity === "blocking") ? "Needs Attention" : checks.some(([, pass]) => !pass) ? "Warnings" : "SEO Ready";
  return <section className="seo-readiness"><h4>SEO Readiness: {status}</h4><p className="platform-muted">Advisory editorial checks—not a search-ranking score.</p><ul>{checks.map(([name, pass, severity]) => <li key={name} className={pass ? "pass" : severity}>{pass ? "PASS" : severity === "blocking" ? "BLOCKING" : "WARNING"} — {name}</li>)}</ul></section>;
}

function BlogDraftPreview({ id }: { id: string }) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState("");
  useEffect(() => {
    void platformApi
      .blogArticlePreview(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Preview could not be loaded."));
  }, [id]);
  if (error)
    return (
      <section className="platform-panel">
        <Link to={`/website/${id}`}>← Back to editor</Link>
        <p role="alert">{error}</p>
      </section>
    );
  if (!data)
    return (
      <section className="platform-panel">
        <p>Loading draft preview…</p>
      </section>
    );
  const a = data.article;
  return (
    <section className="platform-panel blog-draft-preview">
      <Link to={`/website/${id}`}>← Back to editor</Link>
      <p className="platform-muted">Draft preview · not public · noindex</p>
      <article className="article-page">
        <header>
          <span>{a.category}</span>
          <h1>{a.title}</h1>
          <p>{a.excerpt}</p>
          <small>{a.author}</small>
        </header>
        {a.featured_image_public_url ? (
          <img
            className="article-image"
            src={cmsMediaUrl(a.featured_image_public_url)}
            alt={a.featured_image_alt ?? ""}
            onError={(event) => useArticleImageFallback(event, a.slug)}
          />
        ) : null}
        <div className="article-body">
          {(a.content ?? []).map((b: any, i: number) => (
            <PreviewBlock key={i} block={b} />
          ))}
        </div>
      </article>
    </section>
  );
}

function PreviewBlock({ block }: { block: any }) {
  if (block.type === "html")
    return <div dangerouslySetInnerHTML={{ __html: safeEditorHtml(block.text ?? "") }} />;
  if (block.type === "h2") return <h2>{block.text}</h2>;
  if (block.type === "h3") return <h3>{block.text}</h3>;
  if (block.type === "blockquote") return <blockquote>{block.text}</blockquote>;
  if (block.type === "bullet_list")
    return (
      <ul>
        {block.items?.map((x: string) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    );
  if (block.type === "numbered_list")
    return (
      <ol>
        {block.items?.map((x: string) => (
          <li key={x}>{x}</li>
        ))}
      </ol>
    );
  return <p>{block.text}</p>;
}

function Settings() {
  const session = usePlatformSession(),
    [s, setS] = useState<any>();
  useEffect(() => {
    if (session.can("platform.public_site_settings.manage"))
      void platformApi
        .publicSiteSettings()
        .then((x) =>
          setS({
            canonicalBaseUrl: x.canonical_base_url,
            defaultSiteTitle: x.default_site_title,
            defaultMetaDescription: x.default_meta_description,
            defaultSocialImage: x.default_social_image ?? "",
            searchConsoleVerification: x.search_console_verification ?? "",
            gtmContainerId: x.gtm_container_id ?? "",
            ga4MeasurementId: x.ga4_measurement_id ?? "",
            analyticsEnabled: x.analytics_enabled,
            clarityProjectId: x.clarity_project_id ?? "",
            clarityEnabled: x.clarity_enabled,
            trackingEnvironment: x.tracking_environment,
          }),
        );
  }, [session]);
  if (!s) return <p className="platform-muted">SEO settings require permission.</p>;
  const set = (k: string, v: any) => setS({ ...s, [k]: v });
  return (
    <article className="lead-workflow">
      <h3>SEO / Tracking Settings</h3>
      <div className="platform-filters">
        <label>
          Canonical base URL
          <input
            value={s.canonicalBaseUrl}
            onChange={(e) => set("canonicalBaseUrl", e.target.value)}
          />
        </label>
        <label>
          Search Console token
          <input
            value={s.searchConsoleVerification}
            onChange={(e) => set("searchConsoleVerification", e.target.value)}
          />
        </label>
        <label>
          GTM ID
          <input
            placeholder="GTM-XXXXXXX"
            value={s.gtmContainerId}
            onChange={(e) => set("gtmContainerId", e.target.value)}
          />
        </label>
        <label>
          GA4 ID
          <input
            placeholder="G-XXXXXXXXXX"
            value={s.ga4MeasurementId}
            onChange={(e) => set("ga4MeasurementId", e.target.value)}
          />
        </label>
        <label>
          Clarity Project ID
          <input
            value={s.clarityProjectId}
            onChange={(e) => set("clarityProjectId", e.target.value)}
          />
        </label>
        <label>
          Environment
          <select
            value={s.trackingEnvironment}
            onChange={(e) => set("trackingEnvironment", e.target.value)}
          >
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={s.analyticsEnabled}
            onChange={(e) => set("analyticsEnabled", e.target.checked)}
          />{" "}
          Analytics enabled
        </label>
        <label>
          <input
            type="checkbox"
            checked={s.clarityEnabled}
            onChange={(e) => set("clarityEnabled", e.target.checked)}
          />{" "}
          Clarity enabled
        </label>
        <button
          onClick={() =>
            void platformApi
              .updatePublicSiteSettings({
                ...s,
                defaultSocialImage: s.defaultSocialImage || undefined,
                searchConsoleVerification: s.searchConsoleVerification || undefined,
                gtmContainerId: s.gtmContainerId || undefined,
                ga4MeasurementId: s.ga4MeasurementId || undefined,
                clarityProjectId: s.clarityProjectId || undefined,
              })
              .then(setS)
          }
        >
          Save SEO settings
        </button>
      </div>
      <p className="platform-muted">
        GTM takes precedence over direct GA4 to prevent duplicate events. Tracking loads only in the
        configured environment.
      </p>
    </article>
  );
}
