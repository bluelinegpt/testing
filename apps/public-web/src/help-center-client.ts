import { apiUrl } from "./api-base";
import type { Locale } from "./website-cms-client";

export type HelpCategory = {
  id: string;
  slug: string;
  locale: Locale;
  name: string;
  description: string;
  audience: string;
  icon?: string | null;
  sortOrder: number;
  articleCount: number;
};

export type HelpArticleSummary = {
  slug: string;
  locale: Locale;
  title: string;
  summary: string;
  audience: string;
  featured?: boolean;
  categorySlug?: string | null;
  categoryName?: string | null;
  type?: "article" | "faq";
};

export type HelpArticleBlock = {
  type: "paragraph" | "h2" | "h3" | "bullet_list" | "numbered_list" | "image" | "blockquote";
  text?: string;
  items?: string[];
  url?: string;
  alt?: string;
};

export type HelpArticle = {
  slug: string;
  locale: Locale;
  title: string;
  summary: string;
  body: HelpArticleBlock[];
  audience: string;
  seo_title?: string | null;
  meta_description?: string | null;
  canonical_path?: string | null;
  robots_index?: boolean;
  robots_follow?: boolean;
  categorySlug?: string | null;
  categoryName?: string | null;
};

/** Preload cache keys -- see preload-context.ts. One source of truth for
    the key each component reads and the key entry-server.tsx writes. */
export const helpHomePreloadKey = (locale: Locale) => `help-home:${locale}`;
export const helpArticlePreloadKey = (slug: string, locale: Locale) =>
  `help-article:${slug}:${locale}`;

export async function loadHelpHome(locale: Locale) {
  const response = await fetch(apiUrl(`/public/website/help?locale=${locale}`), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Help Center could not be loaded.");
  return (await response.json()) as {
    locale: Locale;
    direction: "ltr" | "rtl";
    categories: HelpCategory[];
    articles: HelpArticleSummary[];
  };
}

export async function searchHelp(locale: Locale, query: string, audience = "all", category = "") {
  const params = new URLSearchParams({ locale, q: query, audience });
  if (category) params.set("category", category);
  const response = await fetch(apiUrl(`/public/website/help/search?${params.toString()}`), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Search could not be completed.");
  return (await response.json()) as { locale: Locale; results: HelpArticleSummary[] };
}

export async function loadHelpArticle(slug: string, locale: Locale) {
  const response = await fetch(apiUrl(`/public/website/help/articles/${slug}?locale=${locale}`), {
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as { article: HelpArticle; related: HelpArticleSummary[] };
}
