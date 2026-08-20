import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiUrl, publicAssetUrl } from "./api-base";
import { trackEvent } from "./analytics";
import { applyPageMetadata } from "./seo";
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
async function api<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(`/public/blog${path}`));
  if (!response.ok) throw new Error(response.status === 404 ? "not_found" : "load_failed");
  return response.json();
}
const currentLocale = () => localStorage.getItem("tawseelhub.locale") === "ar" ? "ar" : "en";
export function BlogListingPage() {
  const { categorySlug } = useParams(),
    [query, setQuery] = useSearchParams(),
    [data, setData] = useState<{ items: Card[]; page: number; pageSize: number; total: number }>(),
    [categories, setCategories] = useState<
      Array<{ name: string; slug: string; description?: string }>
    >([]),
    [failed, setFailed] = useState(false),
    page = Math.max(1, Number(query.get("page")) || 1),
    locale = currentLocale();
  useEffect(() => {
    setFailed(false);
    void Promise.all([
      api<any>(`?language=${locale}&page=${page}${categorySlug ? `&category=${categorySlug}` : ""}`),
      api<any[]>(`/categories?language=${locale}`),
    ])
      .then(([d, c]) => {
        setData(d);
        setCategories(c);
      })
      .catch(() => setFailed(true));
    trackEvent(categorySlug ? "blog_category_view" : "blog_view", {
      category_slug: categorySlug,
      language: locale,
    });
  }, [categorySlug, page, locale]);
  const title = categorySlug
    ? (categories.find((x) => x.slug === categorySlug)?.name ?? "Blog Category")
    : "Tawseelhub Insights";
  useEffect(
    () =>
      applyPageMetadata(
        `${title} | Tawseelhub`,
        categorySlug
          ? `Tawseelhub articles about ${title}.`
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
          Delivery knowledge
        </p>
        <h1>{title}</h1>
        <p>Useful, practical thinking for stronger delivery operations across the UAE.</p>
      </section>
      <nav className="blog-categories" aria-label="Blog categories">
        <Link to="/blog">All</Link>
        {categories.map((c) => (
          <Link key={c.slug} to={`/blog/category/${c.slug}`}>
            {c.name}
          </Link>
        ))}
      </nav>
      <section className="blog-listing">
        {failed ? (
          <div className="empty-content">
            <h2>Articles are temporarily unavailable</h2>
            <p>Please try again shortly.</p>
          </div>
        ) : !data ? (
          <p>Loading articles…</p>
        ) : data.items.length === 0 ? (
          <div className="empty-content">
            <h2>No published articles yet</h2>
            <p>Platform staff can prepare reviewed content in Website Content.</p>
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
                <button onClick={() => setQuery({ page: String(page - 1) })}>Previous</button>
              )}
              <span>Page {page}</span>
              {page * data.pageSize < data.total && (
                <button onClick={() => setQuery({ page: String(page + 1) })}>Next</button>
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
  return (
    <article className={featured ? "blog-card featured" : ""}>
      {imageUrl && (
        <img
          src={imageUrl}
          alt={article.featuredImageAlt ?? ""}
          loading={featured ? "eager" : "lazy"}
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
          {article.readingMinutes} min read
        </small>
      </div>
    </article>
  );
}
export function BlogArticlePage() {
  const { slug = "" } = useParams(),
    [data, setData] = useState<{
      article: Article;
      related: Array<{ slug: string; title: string; excerpt: string }>;
    }>(),
    [missing, setMissing] = useState(false),
    locale = currentLocale();
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
        <h1>Article not found</h1>
        <p>This article is not published or the address is incorrect.</p>
        <Link to="/blog">Return to Blog</Link>
      </section>
    );
  if (!data) return <section className="article-empty">Loading article…</section>;
  const a = data.article;
  const featuredImageUrl = publicAssetUrl(a.featured_image_public_url);
  return (
    <article className="article-page" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
      <nav aria-label="Breadcrumb">
        <Link to="/">Home</Link> / <Link to="/blog">Blog</Link> /{" "}
        <Link to={`/blog/category/${a.category_slug}`}>{a.category}</Link>
      </nav>
      <header>
        <span>{a.category}</span>
        <h1>{a.title}</h1>
        <p>{a.excerpt}</p>
        <small>
          {a.author} · Published {new Date(a.published_at).toLocaleDateString()}
          {a.updated_content_at
            ? ` · Updated ${new Date(a.updated_content_at).toLocaleDateString()}`
            : ""}
        </small>
      </header>
      {featuredImageUrl && (
        <img
          className="article-image"
          src={featuredImageUrl}
          alt={a.featured_image_alt ?? ""}
        />
      )}
      <div className="article-layout">
        <div className="article-body">
          {a.content.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>
        <aside>
          <h2>Explore Tawseelhub</h2>
          <Link to="/delivery-companies">Delivery Company platform</Link>
          <Link to="/traders">Solutions for Traders</Link>
          <Link to="/send-a-package">Send a Package</Link>
        </aside>
      </div>
      <section className="related-articles">
        <h2>Related articles</h2>
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
