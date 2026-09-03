import { useContext, useEffect, useState, type SyntheticEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiUrl, publicAssetUrl } from "./api-base";
import { trackEvent } from "./analytics";
import { applyPageMetadata } from "./seo";
import { getPreloaded, PreloadContext } from "./preload-context";
import { usePublicLocale } from "./public-localization";
import { BlogEnquiry } from "./BlogEnquiry";
/** Preload cache keys, exported so entry-server.tsx populates the exact
    same keys these components read -- one source of truth for both sides. */
export const blogListingPreloadKey = (locale: string, page: number, categorySlug?: string) =>
  `blog-listing:${locale}:${page}:${categorySlug ?? ""}`;
export const blogCategoriesPreloadKey = (locale: string) => `blog-categories:${locale}`;
export const blogArticlePreloadKey = (slug: string, locale: string) =>
  `blog-article:${slug}:${locale}`;

type Card = {
  slug: string;
  title: string;
  excerpt: string;
  featuredImageUrl?: string;
  featuredImageAlt?: string;
  publishedAt: string;
  updatedAt?: string;
  category: string;
  categorySlug: string;
  author: string;
  readingMinutes: number;
};
type Block = { type: string; text?: string; items?: string[] };
type Article = Record<string, unknown> & {
  slug: string;
  title: string;
  excerpt: string;
  content: Block[];
  category: string;
  category_slug: string;
  author: string;
  published_at: string;
  updated_content_at?: string;
  featured_image_public_url?: string;
  featured_image_alt?: string;
  seo_title?: string;
  meta_description?: string;
  canonical_url?: string;
  robots_index: boolean;
  robots_follow: boolean;
  social_title?: string;
  social_description?: string;
  social_image_url?: string;
};
/**
 * A request that never settles -- a dropped connection, a dev-server
 * mid-restart, a proxy that swallows the response -- used to leave this
 * page showing "Loading articles..." forever: `Promise.all` never resolves
 * or rejects, so neither the success path nor `.catch` ever ran. A hard
 * timeout guarantees the request always settles one way or the other, so
 * the page can always fall back to the retry state instead of hanging.
 */
const requestTimeoutMs = 12_000;
async function api<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(apiUrl(`/public/blog${path}`), { signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 404 ? "not_found" : "load_failed");
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
const blogText = {
  en: {
    defaultTitle: "Tawseelhub Insights",
    categoryTitle: "Blog Category",
    eyebrow: "Delivery knowledge",
    heroCopy: "Useful, practical thinking for stronger delivery operations across the UAE.",
    categories: "Blog categories",
    all: "All",
    unavailableTitle: "Articles are temporarily unavailable",
    unavailableCopy: "Please try again shortly.",
    retry: "Retry",
    loading: "Loading articles…",
    emptyTitle: "No published articles yet",
    emptyCopy: "Platform staff can prepare reviewed content in Website Content.",
    previous: "Previous",
    next: "Next",
    page: "Page",
    minRead: "min read",
    readPreview: "Read preview",
    notFoundTitle: "Article not found",
    notFoundCopy: "This article is not published or the address is incorrect.",
    returnBlog: "Return to Blog",
    loadingArticle: "Loading article…",
    home: "Home",
    blog: "Blog",
    published: "Published",
    updated: "Updated",
    explore: "Explore Tawseelhub",
    deliveryCompany: "Delivery Company platform",
    traders: "Solutions for Traders",
    sendPackage: "Send a Package",
    related: "Related articles",
  },
  ar: {
    defaultTitle: "مدونة Tawseelhub",
    categoryTitle: "فئة المدونة",
    eyebrow: "معرفة التوصيل",
    heroCopy: "أفكار عملية مفيدة لبناء عمليات توصيل أقوى في الإمارات.",
    categories: "فئات المدونة",
    all: "الكل",
    unavailableTitle: "المقالات غير متاحة مؤقتاً",
    unavailableCopy: "يرجى المحاولة مرة أخرى بعد قليل.",
    retry: "إعادة المحاولة",
    loading: "جاري تحميل المقالات…",
    emptyTitle: "لا توجد مقالات منشورة بعد",
    emptyCopy: "يمكن لفريق المنصة تجهيز محتوى مراجع من إدارة محتوى الموقع.",
    previous: "السابق",
    next: "التالي",
    page: "صفحة",
    minRead: "دقائق قراءة",
    readPreview: "اقرأ المقال",
    notFoundTitle: "المقال غير موجود",
    notFoundCopy: "هذا المقال غير منشور أو أن العنوان غير صحيح.",
    returnBlog: "العودة إلى المدونة",
    loadingArticle: "جاري تحميل المقال…",
    home: "الرئيسية",
    blog: "المدونة",
    published: "نشر",
    updated: "تحديث",
    explore: "استكشف Tawseelhub",
    deliveryCompany: "منصة شركة التوصيل",
    traders: "حلول للتجار",
    sendPackage: "أرسل شحنة",
    related: "مقالات ذات صلة",
  },
} as const;
function articleImageFallback(slug: string): string {
  return slug === "manage-cod-delivery-operations"
    ? "/blog-images/manage-cod-delivery-operations.jpg"
    : "";
}

function useArticleImageFallback(event: SyntheticEvent<HTMLImageElement>, slug: string): void {
  const fallback = articleImageFallback(slug);
  if (!fallback || event.currentTarget.src.endsWith(fallback)) {
    event.currentTarget.remove();
    return;
  }
  event.currentTarget.src = fallback;
}

export function BlogListingPage() {
  const preloadMap = useContext(PreloadContext);
  const { categorySlug } = useParams(),
    [query, setQuery] = useSearchParams(),
    page = Math.max(1, Number(query.get("page")) || 1),
    locale = usePublicLocale(),
    [data, setData] = useState<
      { items: Card[]; page: number; pageSize: number; total: number } | undefined
    >(() => getPreloaded(preloadMap, blogListingPreloadKey(locale, page, categorySlug))),
    [categories, setCategories] = useState<
      Array<{ name: string; slug: string; description?: string }>
    >(() => getPreloaded(preloadMap, blogCategoriesPreloadKey(locale)) ?? []),
    [failed, setFailed] = useState(false),
    [retryToken, setRetryToken] = useState(0);
  const text = blogText[locale];
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      api<any>(
        `?language=${locale}&page=${page}${categorySlug ? `&category=${categorySlug}` : ""}`,
      ),
      api<any[]>(`/categories?language=${locale}`),
    ])
      .then(([d, c]) => {
        if (cancelled) return;
        setData(d);
        setCategories(c);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    trackEvent(categorySlug ? "blog_category_view" : "blog_view", {
      category_slug: categorySlug,
      language: locale,
    });
    return () => {
      cancelled = true;
    };
  }, [categorySlug, page, locale, retryToken]);
  const title = categorySlug
    ? (categories.find((x) => x.slug === categorySlug)?.name ?? text.categoryTitle)
    : text.defaultTitle;
  useEffect(
    () =>
      applyPageMetadata(
        `${title} | Tawseelhub`,
        categorySlug
          ? locale === "ar"
            ? `مقالات Tawseelhub حول ${title}.`
            : `Tawseelhub articles about ${title}.`
          : locale === "ar"
            ? "إرشادات عملية لشركات التوصيل والتجار وعمليات الميل الأخير الحديثة."
            : "Practical guidance for UAE delivery companies, Traders and modern last-mile operations.",
        categorySlug ? `/blog/category/${categorySlug}` : "/blog",
      ),
    [categorySlug, title],
  );
  return (
    <>
      <section className="blog-hero" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
        <p className="eyebrow">
          <span />
          {text.eyebrow}
        </p>
        <h1>{title}</h1>
        <p>{text.heroCopy}</p>
      </section>
      <nav className="blog-categories" aria-label={text.categories}>
        <Link to="/blog">{text.all}</Link>
        {categories.map((c) => (
          <Link key={c.slug} to={`/blog/category/${c.slug}`}>
            {c.name}
          </Link>
        ))}
      </nav>
      <section className="blog-listing">
        {failed ? (
          <div className="empty-content">
            <h2>{text.unavailableTitle}</h2>
            <p>{text.unavailableCopy}</p>
            <button
              className="button button-secondary"
              onClick={() => setRetryToken((n) => n + 1)}
              type="button"
            >
              {text.retry}
            </button>
          </div>
        ) : !data ? (
          <p>{text.loading}</p>
        ) : data.items.length === 0 ? (
          <div className="empty-content">
            <h2>{text.emptyTitle}</h2>
            <p>{text.emptyCopy}</p>
          </div>
        ) : (
          <>
            <article className="featured-article">
              <CardView article={data.items[0]!} featured />
            </article>
            <div className="blog-grid">
              {data.items.slice(1).map((a) => (
                <CardView key={a.slug} article={a} />
              ))}
            </div>
            <div className="blog-pagination">
              {page > 1 && (
                <button onClick={() => setQuery({ page: String(page - 1) })}>
                  {text.previous}
                </button>
              )}
              <span>
                {text.page} {page}
              </span>
              {page * data.pageSize < data.total && (
                <button onClick={() => setQuery({ page: String(page + 1) })}>{text.next}</button>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
function CardView({ article, featured = false }: { article: Card; featured?: boolean }) {
  const imageUrl = publicAssetUrl(article.featuredImageUrl);
  const locale = usePublicLocale();
  const text = blogText[locale];
  return (
    <article className={featured ? "blog-card featured" : ""}>
      {imageUrl && (
        <img
          src={imageUrl}
          alt={article.featuredImageAlt ?? ""}
          loading={featured ? "eager" : "lazy"}
          onError={(event) => useArticleImageFallback(event, article.slug)}
        />
      )}
      <div>
        <Link className="blog-category" to={`/blog/category/${article.categorySlug}`}>
          {article.category}
        </Link>
        <h2>
          <Link to={`/blog/${article.slug}`}>{article.title}</Link>
        </h2>
        <p>{article.excerpt}</p>
        <small>
          {article.author} · {new Date(article.publishedAt).toLocaleDateString()} ·{" "}
          {article.readingMinutes} {text.minRead}
        </small>
      </div>
    </article>
  );
}
export function BlogArticlePage() {
  const preloadMap = useContext(PreloadContext);
  const { slug = "" } = useParams(),
    locale = usePublicLocale(),
    [data, setData] = useState<
      | {
          article: Article;
          related: Array<{ slug: string; title: string; excerpt: string }>;
        }
      | undefined
    >(() => getPreloaded(preloadMap, blogArticlePreloadKey(slug, locale))),
    [missing, setMissing] = useState(false);
  const text = blogText[locale];
  useEffect(() => {
    void api<any>(`/articles/${slug}?language=${locale}`)
      .then((x) => {
        if (x.redirect) {
          location.replace(x.redirect.to);
          return;
        }
        setData(x);
      })
      .catch(() => setMissing(true));
  }, [slug, locale]);
  useEffect(() => {
    if (!data) return;
    const a = data.article;
    const featuredImageUrl = publicAssetUrl(a.featured_image_public_url);
    const socialImageUrl = publicAssetUrl(a.social_image_url);
    applyPageMetadata(
      String(a.seo_title ?? a.title),
      String(a.meta_description ?? a.excerpt),
      `/blog/${a.slug}`,
      {
        type: "article",
        image: socialImageUrl || featuredImageUrl,
        canonical: String(a.canonical_url ?? ""),
        robots: `${a.robots_index ? "index" : "noindex"},${a.robots_follow ? "follow" : "nofollow"}`,
      },
    );
    trackEvent("blog_article_view", {
      article_slug: a.slug,
      category_slug: a.category_slug,
      language: locale,
    });
    const schema = document.createElement("script");
    schema.type = "application/ld+json";
    schema.dataset.blogSchema = "true";
    schema.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: a.title,
      description: a.excerpt,
      datePublished: a.published_at,
      dateModified: a.updated_content_at ?? a.published_at,
      author: { "@type": "Organization", name: a.author },
      publisher: {
        "@type": "Organization",
        name: "Tawseelhub",
        logo: { "@type": "ImageObject", url: "https://tawseelhub.com/tawseelhub-logo.png" },
      },
      mainEntityOfPage: `https://tawseelhub.com/blog/${a.slug}`,
      ...(featuredImageUrl ? { image: featuredImageUrl } : {}),
    });
    document.head.append(schema);
    return () => schema.remove();
  }, [data, locale]);
  if (missing)
    return (
      <section className="article-empty">
        <h1>{text.notFoundTitle}</h1>
        <p>{text.notFoundCopy}</p>
        <Link to="/blog">{text.returnBlog}</Link>
      </section>
    );
  if (!data) return <section className="article-empty">{text.loadingArticle}</section>;
  const a = data.article;
  const featuredImageUrl = publicAssetUrl(a.featured_image_public_url);
  return (
    <article className="article-page" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
      <nav aria-label="Breadcrumb">
        <Link to="/">{text.home}</Link> / <Link to="/blog">{text.blog}</Link> /{" "}
        <Link to={`/blog/category/${a.category_slug}`}>{a.category}</Link>
      </nav>
      <header>
        <span>{a.category}</span>
        <h1>{a.title}</h1>
        <p>{a.excerpt}</p>
        <small>
          {a.author} · {text.published}{" "}
          {new Date(a.published_at).toLocaleDateString(locale === "ar" ? "ar-AE" : "en-AE")}
          {a.updated_content_at
            ? ` · ${text.updated} ${new Date(a.updated_content_at).toLocaleDateString(locale === "ar" ? "ar-AE" : "en-AE")}`
            : ""}
        </small>
      </header>
      {featuredImageUrl && (
        <img
          className="article-image"
          src={featuredImageUrl}
          alt={a.featured_image_alt ?? ""}
          onError={(event) => useArticleImageFallback(event, a.slug)}
        />
      )}
      <div className="article-layout">
        <div className="article-body">
          {a.content.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>
        <aside>
          <h2>{text.explore}</h2>
          <Link to="/delivery-companies">{text.deliveryCompany}</Link>
          <Link to="/traders">{text.traders}</Link>
          <Link to="/send-a-package">{text.sendPackage}</Link>
        </aside>
      </div>
      <BlogEnquiry key={a.slug} slug={a.slug} language={String(a.language ?? "en")} />
      <section className="related-articles">
        <h2>{text.related}</h2>
        {data.related.map((x) => (
          <article key={x.slug}>
            <h3>
              <Link to={`/blog/${x.slug}`}>{x.title}</Link>
            </h3>
            <p>{x.excerpt}</p>
          </article>
        ))}
      </section>
    </article>
  );
}
function BlockView({ block }: { block: Block }) {
  // HTML blocks are allowlist-sanitized by the API on both save and public reads.
  if (block.type === "html") return <div dangerouslySetInnerHTML={{__html: (block.text ?? "").replace(/src="(\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+)"/g, (_match, path:string) => `src="${publicAssetUrl(path).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;")}"`)}} />;
  if (block.type === "h2") return <h2>{block.text}</h2>;
  if (block.type === "h3") return <h3>{block.text}</h3>;
  if (block.type === "blockquote") return <blockquote>{block.text}</blockquote>;
  if (block.type === "bullet_list")
    return (
      <ul>
        {block.items?.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    );
  if (block.type === "numbered_list")
    return (
      <ol>
        {block.items?.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ol>
    );
  return <p>{block.text}</p>;
}
