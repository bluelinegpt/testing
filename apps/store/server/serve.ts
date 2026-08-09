import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import {
  canonicalUrl,
  isSeoLocale,
  categoryIndexSeoDocument,
  marketplaceSeoDocument,
  normaliseOrigin,
  notFoundSeoDocument,
  productSeoDocument,
  storeSeoDocument,
  taxonomySeoDocument,
  type ProductSeoInput,
  type SeoDocument,
  type SeoLocale,
  type StoreSeoInput,
  type TaxonomySeoInput,
} from "../src/seo/seo-document.js";
import { escapeHtml, injectMetadata } from "../src/seo/render-metadata.js";

/**
 * The Store's production server.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `apps/store` is a Vite SPA: its built `index.html` is one static shell with
 * one static title. A crawler or a social-preview agent fetching
 * `/en/some-shop/products/some-product` receives that shell and nothing else,
 * because none of them execute React. Setting `document.title` after hydration
 * is invisible to every one of them.
 *
 * So this server does the minimum required to fix that and nothing more: it
 * recognises the public routes, fetches the same PUBLIC Commerce API the
 * browser would call, generates metadata, and injects it into the built shell
 * before responding. React then boots and renders the page exactly as before.
 *
 * It is deliberately not SSR. No React is imported, no component is rendered,
 * and no framework was introduced — the application is untouched, and only the
 * `<head>` differs from what Vite produced.
 *
 * ---------------------------------------------------------------------------
 * FAILING SAFELY MATTERS MORE THAN FAILING INFORMATIVELY
 * ---------------------------------------------------------------------------
 *
 * Every API call is bounded by a timeout. If the API is slow or down the server
 * still answers, with generic non-indexable metadata and a 200 — NOT a 404,
 * because a 404 emitted during a backend outage teaches search engines that
 * real pages are gone, and that is expensive to undo.
 *
 * A genuine missing resource does return 404, with `noindex,nofollow` and no
 * internal error text of any kind.
 */

const port = Number.parseInt(process.env.STORE_PORT ?? "8081", 10);
const publicDirectory = resolve(process.env.STORE_ROOT ?? "dist");
const apiOrigin = process.env.STORE_API_ORIGIN ?? "http://localhost:3000";
const siteName = process.env.STORE_SITE_NAME ?? "BluelineGPT Store";
/** Throws at startup on a malformed origin rather than emitting bad canonicals. */
const publicOrigin = normaliseOrigin(process.env.STORE_PUBLIC_ORIGIN ?? "http://localhost:8081");
const apiTimeoutMs = Number.parseInt(process.env.STORE_API_TIMEOUT_MS ?? "2500", 10);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

function addSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

/** A bounded public API read. Returns null on any failure, never throws. */
async function apiGet<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs);
  try {
    const response = await fetch(`${apiOrigin}/api/v1/${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RouteMatch {
  readonly kind:
    | "category"
    | "categoryIndex"
    | "marketplace"
    | "product"
    | "store"
    | "subcategory";
  readonly locale: SeoLocale;
  readonly segments: readonly string[];
}

/**
 * Which public document a path refers to.
 *
 * A leading `en`/`ar` selects the locale; anything else is treated as the
 * default locale's content at an unprefixed path, so existing links keep
 * working. Only `en` and `ar` are accepted as locale prefixes — an arbitrary
 * segment is a Store slug, not a language.
 */
function matchRoute(pathname: string): RouteMatch | null {
  const raw = pathname.split("/").filter((segment) => segment !== "");
  let locale: SeoLocale = "en";
  let segments = raw;
  if (raw.length > 0 && isSeoLocale(raw[0]!)) {
    locale = raw[0] as SeoLocale;
    segments = raw.slice(1);
  }

  if (segments.length === 0) return { kind: "marketplace", locale, segments: [] };
  if (segments[0] === "categories") {
    // The category INDEX is a real browsable page and is listed in the
    // sitemap. Falling through to not-found here published it as
    // `noindex,nofollow` while simultaneously advertising it -- a page the
    // sitemap asks a crawler to fetch and the page itself tells it to drop.
    if (segments.length === 1) return { kind: "categoryIndex", locale, segments: [] };
    if (segments.length === 2) return { kind: "category", locale, segments: segments.slice(1) };
    if (segments.length === 3) return { kind: "subcategory", locale, segments: segments.slice(1) };
    return null;
  }
  if (segments.length === 1) return { kind: "store", locale, segments };
  if (segments.length === 3 && segments[1] === "products") {
    return { kind: "product", locale, segments: [segments[0]!, segments[2]!] };
  }
  return null;
}

interface DocumentResult {
  readonly document: SeoDocument;
  readonly status: number;
}

async function documentFor(match: RouteMatch): Promise<DocumentResult> {
  const base = { locale: match.locale, origin: publicOrigin, siteName };

  if (match.kind === "marketplace") {
    return { document: marketplaceSeoDocument(base), status: 200 };
  }

  if (match.kind === "categoryIndex") {
    return { document: categoryIndexSeoDocument(base), status: 200 };
  }

  if (match.kind === "store") {
    const slug = match.segments[0]!;
    const store = await apiGet<StoreSeoInput>(`public/storefronts/${encodeURIComponent(slug)}`);
    if (store === null) {
      return {
        document: notFoundSeoDocument({ ...base, path: slug }),
        status: 404,
      };
    }
    return {
      document: storeSeoDocument({ ...base, store: { ...store, slug: store.slug || slug } }),
      status: 200,
    };
  }

  if (match.kind === "product") {
    const [storeSlug, productSlug] = match.segments as [string, string];
    const [store, product] = await Promise.all([
      apiGet<StoreSeoInput>(`public/storefronts/${encodeURIComponent(storeSlug)}`),
      apiGet<ProductSeoInput>(
        `public/storefronts/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productSlug)}`,
      ),
    ]);
    if (store === null || product === null) {
      return {
        document: notFoundSeoDocument({ ...base, path: `${storeSlug}/products/${productSlug}` }),
        status: 404,
      };
    }
    return {
      document: productSeoDocument({
        ...base,
        product: { ...product, slug: product.slug || productSlug },
        store: { ...store, slug: store.slug || storeSlug },
      }),
      status: 200,
    };
  }

  const categorySlug = match.segments[0]!;
  const category = await apiGet<TaxonomySeoInput>(
    `public/marketplace/categories/${encodeURIComponent(categorySlug)}`,
  );
  if (category === null) {
    return {
      document: notFoundSeoDocument({ ...base, path: `categories/${categorySlug}` }),
      status: 404,
    };
  }
  if (match.kind === "category") {
    return {
      document: taxonomySeoDocument({ ...base, category }),
      status: 200,
    };
  }

  const subSlug = match.segments[1]!;
  const subcategory = await apiGet<TaxonomySeoInput>(
    `public/marketplace/categories/${encodeURIComponent(categorySlug)}/subcategories/${encodeURIComponent(subSlug)}`,
  );
  if (subcategory === null) {
    return {
      document: notFoundSeoDocument({
        ...base,
        path: `categories/${categorySlug}/${subSlug}`,
      }),
      status: 404,
    };
  }
  return {
    document: taxonomySeoDocument({ ...base, category, subcategory }),
    status: 200,
  };
}

/**
 * robots.txt.
 *
 * Public Commerce paths are crawlable; account, cart, checkout and the API are
 * not. Assets are deliberately NOT blocked — a crawler that cannot fetch the
 * stylesheet cannot judge the page it is rendering.
 */
function robotsTxt(): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /account",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /cart",
    "Disallow: /checkout",
    "Disallow: /orders",
    // Commerce media is public and is exactly what `og:image` points at. It
    // must be listed BEFORE the broader `/api/` rule: a scraper that honours
    // robots would otherwise refuse to fetch the share image, and the WhatsApp
    // preview for every Product would arrive with no picture.
    "Allow: /api/v1/public/commerce-media/",
    "Disallow: /api/",
    "",
    `Sitemap: ${publicOrigin}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * sitemap.xml.
 *
 * Built from the same public endpoints the site itself uses, so a resource that
 * is not publicly resolvable cannot appear here: unpublished Stores, draft
 * Products and inactive taxonomy are already absent from those responses.
 *
 * Single document, which is right for the current volume. The URL set is
 * assembled in one place so sharding into a sitemap index later is a change to
 * this function alone.
 */
async function sitemapXml(): Promise<string> {
  const urls: string[] = [];
  const add = (path: string) => {
    for (const locale of ["en", "ar"] as const) {
      urls.push(canonicalUrl(publicOrigin, locale, path));
    }
  };

  add("");
  add("categories");

  const stores = await apiGet<{ items: { slug: string }[] }>("public/storefronts");
  for (const store of stores?.items ?? []) {
    add(store.slug);
    const products = await apiGet<{ items: { slug: string }[] }>(
      `public/storefronts/${encodeURIComponent(store.slug)}/products?pageSize=48`,
    );
    for (const product of products?.items ?? []) {
      add(`${store.slug}/products/${product.slug}`);
    }
  }

  const categories = await apiGet<{ items: { slug: string }[] }>(
    "public/marketplace/categories",
  );
  for (const category of categories?.items ?? []) {
    add(`categories/${category.slug}`);
    const detail = await apiGet<{ subcategories: { slug: string }[] }>(
      `public/marketplace/categories/${encodeURIComponent(category.slug)}`,
    );
    for (const child of detail?.subcategories ?? []) {
      add(`categories/${category.slug}/${child.slug}`);
    }
  }

  const body = urls
    .map((url) => `  <url><loc>${escapeHtml(url)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function resolveAsset(pathname: string): string | undefined {
  const candidate = resolve(publicDirectory, `.${normalize(pathname)}`);
  const relativePath = relative(publicDirectory, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

const shellPath = join(publicDirectory, "index.html");

/**
 * Forward one public API read upstream.
 *
 * Timeout-bounded like every other upstream call here: a hung API must produce
 * a fast error, not a socket the browser holds open indefinitely.
 *
 * Upstream failures are passed through as a 502 with a JSON body rather than
 * being dressed up as an empty success -- the client already renders honest
 * error states, and inventing an empty result would show "no products" for a
 * shop that has plenty.
 *
 * The body is copied as BYTES, never as text. `response.text()` decodes as
 * UTF-8, and every byte that is not valid UTF-8 becomes U+FFFD -- which is
 * harmless for JSON and silently destroys an image. A 787KB PNG arrived as
 * 1.3MB of replacement characters, returned 200, and failed to decode in the
 * browser with no error anywhere in the chain. Uploaded Store and Product
 * media travel this path, so this must stay binary-safe.
 */
async function proxyApi(url: URL, response: ServerResponse): Promise<void> {
  const target = `${apiOrigin}${url.pathname}${url.search}`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, apiTimeoutMs);
  try {
    const upstream = await fetch(target, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    // Media is content-addressed by an immutable file id, so it can be cached
    // hard; API reads must not be.
    const cacheControl = contentType.startsWith("image/")
      ? "public, max-age=86400"
      : "no-store";
    response.writeHead(upstream.status, {
      "Cache-Control": cacheControl,
      "Content-Length": body.length,
      "Content-Type": contentType,
    });
    response.end(body);
  } catch {
    response.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "application/json" });
    response.end('{"error":"upstream_unavailable"}');
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  addSecurityHeaders(response);
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  /**
   * The public Commerce API, proxied.
   *
   * The client fetches `/api/...` on its own origin. In development Vite's
   * proxy handles that; in production nothing did, so the shell rendered with
   * correct metadata and then every request 404'd against the static server --
   * a page that looks right to a crawler and is empty for a shopper.
   *
   * Same-origin also keeps the browser out of CORS and preflight entirely, and
   * means the API origin stays a deployment detail rather than something baked
   * into the built bundle.
   *
   * Only GET and HEAD are forwarded. The public Store is read-only, and a
   * proxy that will forward anything is a far larger surface than the one
   * feature that needs it.
   */
  if (pathname.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json" });
      response.end('{"error":"method_not_allowed"}');
      return;
    }
    await proxyApi(url, response);
    return;
  }

  if (pathname === "/healthz") {
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  if (pathname === "/robots.txt") {
    response.writeHead(200, { "Content-Type": contentTypes.get(".txt")! });
    response.end(robotsTxt());
    return;
  }
  if (pathname === "/sitemap.xml") {
    response.writeHead(200, { "Content-Type": contentTypes.get(".xml")! });
    response.end(await sitemapXml());
    return;
  }

  const asset = resolveAsset(pathname);
  if (asset !== undefined) {
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(asset)) ?? "application/octet-stream",
    });
    createReadStream(asset).pipe(response);
    return;
  }

  const match = matchRoute(pathname);
  const shell = readFileSync(shellPath, "utf8");
  if (match === null) {
    const document = notFoundSeoDocument({
      locale: "en",
      origin: publicOrigin,
      path: pathname,
      siteName,
    });
    response.writeHead(404, { "Content-Type": contentTypes.get(".html")! });
    response.end(injectMetadata(shell, document));
    return;
  }

  const { document, status } = await documentFor(match);
  response.writeHead(status, { "Content-Type": contentTypes.get(".html")! });
  response.end(injectMetadata(shell, document));
}

export const server = createServer((request, response) => {
  void handle(request, response).catch(() => {
    // Nothing about the failure reaches the client. A stack trace in a
    // customer-facing response is an information leak, and a crawler has no use
    // for it either.
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("Service unavailable");
  });
});

if (process.env.STORE_SERVER_AUTOSTART !== "false") {
  server.listen(port, () => {
    process.stdout.write(`Store server listening on ${String(port)} (origin ${publicOrigin})\n`);
  });
}
