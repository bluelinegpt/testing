import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Built by the SSR step this script's own npm `build` script runs first
// (`vite build --ssr src/entry-server.tsx --outDir dist-ssr`) -- plain Vite
// SSR, not a second framework. Renders the exact same <App/> tree and
// react-router routes the browser uses; see entry-server.tsx.
import { render } from "../dist-ssr/entry-server.js";

const siteUrl = "https://tawseelhub.com";
const endpoint = process.env.PUBLIC_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1";
const defaultImage = `${siteUrl}/og.png`;

const staticRoutes = [
  {
    path: "/",
    title: "Delivery Operating System for Delivery Companies | Tawseelhub",
    description:
      "Tawseelhub is delivery management software that connects Orders, Drivers, COD collections, Trader settlements, accounting and payroll in one platform — built for UAE delivery companies.",
  },
  {
    path: "/delivery-companies",
    title: "Delivery Management Software UAE | Tawseelhub Delivery Operating System",
    description:
      "Tawseelhub is a Delivery Operating System for UAE delivery companies, combining orders, drivers, COD collections, Trader settlements, accounting, payroll and reporting.",
  },
  {
    path: "/send-a-package",
    title: "Send a Package Across the UAE",
    description:
      "Request a delivery quote for a package across the UAE with pickup, destination, package and COD details.",
  },
  {
    path: "/traders",
    title: "Delivery Solutions for Traders & Online Sellers UAE | Tawseelhub",
    description:
      "Register your business with Tawseelhub, connect your existing Delivery Company or let us help you find a suitable delivery partner for Salla, Shopify, WooCommerce and other sales channels.",
  },
  {
    path: "/traders/register",
    title: "Trader Registration | Tawseelhub",
    description:
      "Apply to register your UAE business with Tawseelhub and prepare a verified delivery relationship.",
  },
  {
    path: "/integrations",
    title: "Commerce Integrations",
    description:
      "Prepare to connect Salla, Shopify and WooCommerce orders to delivery operations through planned Tawseelhub integrations.",
  },
  {
    path: "/resources",
    title: "Delivery Operations Resources",
    description:
      "Practical resources for UAE delivery companies covering COD, failed deliveries, operations and connected sales channels.",
  },
  {
    path: "/blog",
    title: "Tawseelhub Insights",
    description:
      "Insights for delivery companies and Traders building more connected delivery operations in the UAE.",
  },
  {
    path: "/pricing",
    title: "Tawseelhub Pricing | AED Plans for Delivery Companies",
    description:
      "Review Tawseelhub pricing in AED, from a free tier up to high-volume delivery operations. Request a demo for the right plan.",
  },
  {
    path: "/about",
    title: "About Tawseelhub",
    description:
      "Learn why Tawseelhub is building a connected delivery operating system for delivery businesses in the UAE.",
  },
  {
    path: "/contact",
    title: "Contact Tawseelhub",
    description:
      "Contact the Tawseelhub team about delivery operations, partnerships and the platform.",
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    description: "How Tawseelhub handles personal data across the public website and platform.",
  },
  {
    path: "/terms",
    title: "Terms of Service",
    description: "Terms governing use of the Tawseelhub website and platform.",
  },
  {
    path: "/request-demo",
    title: "Request a Tawseelhub Demo",
    description: "Request a tailored demonstration of Tawseelhub for your UAE delivery company.",
  },
  {
    path: "/track",
    title: "Track Your Shipment | Tawseelhub",
    description:
      "Track your shipment securely using your Airway Bill and view the latest delivery status.",
  },
  ...[
    "delivery-operations",
    "cod-finance",
    "business-growth",
    "last-mile-delivery",
    "uae-delivery-guides",
    "salla",
    "shopify",
    "woocommerce",
  ].map((slug) => ({
    path: `/blog/category/${slug}`,
    title: "Tawseelhub Blog",
    description: "Practical guidance for UAE delivery operations.",
  })),
];

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fullTitle(title) {
  return /tawseelhub/i.test(title) ? title : `${title} | Tawseelhub`;
}

function normalizeCanonical(value, path) {
  if (typeof value === "string" && value.trim()) {
    if (/^https?:\/\//i.test(value)) return value;
    return `${siteUrl}${value.startsWith("/") ? value : `/${value}`}`;
  }
  return `${siteUrl}${path}`;
}

function normalizeImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return defaultImage;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/api/")) return `${endpoint.replace(/\/api\/v1\/?$/, "")}${value}`;
  return `${siteUrl}${value.startsWith("/") ? value : `/${value}`}`;
}

async function fetchJson(path) {
  const response = await fetch(`${endpoint}${path}`);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
  return response.json();
}

const routeMap = new Map(
  staticRoutes.map((route) => [route.path, { type: "website", image: defaultImage, ...route }]),
);

// Homepage renders its own "Insights & Resources" cards from the same
// listing endpoint /blog page 1 uses -- preload both from one fetch below.
try {
  const homeListing = await fetchJson("/public/blog?language=en&page=1");
  routeMap.get("/").preload = [["blog-listing:en:1:", homeListing]];
} catch {
  // Left un-preloaded: SSR still renders the section's own honest
  // "coming soon" state (articles === null -> section renders nothing,
  // which is what happens client-side too before the fetch resolves).
}

try {
  const [blogListing, blogCategories] = await Promise.all([
    fetchJson("/public/blog?language=en&page=1"),
    fetchJson("/public/blog/categories?language=en"),
  ]);
  const blogPreload = [
    ["blog-listing:en:1:", blogListing],
    ["blog-categories:en", blogCategories],
  ];
  routeMap.get("/blog").preload = blogPreload;

  const entries = await fetchJson("/public/blog/sitemap-entries");
  for (const entry of entries) {
    if (!String(entry.path ?? "").startsWith("/blog/")) continue;
    if (String(entry.path).startsWith("/blog/category/")) {
      const slug = String(entry.path).replace("/blog/category/", "");
      let categoryListing = blogListing;
      try {
        categoryListing = await fetchJson(
          `/public/blog?language=en&page=1&category=${encodeURIComponent(slug)}`,
        );
      } catch {
        // Falls back to the unfiltered listing above rather than an empty preload.
      }
      routeMap.set(entry.path, {
        path: entry.path,
        title: "Tawseelhub Blog",
        description: "Practical guidance for UAE delivery operations.",
        type: "website",
        image: defaultImage,
        preload: [
          ["blog-listing:en:1:" + slug, categoryListing],
          ["blog-categories:en", blogCategories],
        ],
      });
      continue;
    }
    const slug = String(entry.path).replace("/blog/", "");
    const detail = await fetchJson(`/public/blog/articles/${encodeURIComponent(slug)}?language=en`);
    const article = detail.article ?? detail;
    const image = normalizeImageUrl(article.social_image_url ?? article.featured_image_public_url);
    routeMap.set(entry.path, {
      path: entry.path,
      title: article.seo_title ?? article.social_title ?? article.title ?? "Tawseelhub Blog",
      description:
        article.meta_description ??
        article.social_description ??
        article.excerpt ??
        "Practical guidance for UAE delivery operations.",
      canonical: normalizeCanonical(article.canonical_url, entry.path),
      type: "article",
      image,
      robots: `${article.robots_index === false ? "noindex" : "index"},${article.robots_follow === false ? "nofollow" : "follow"}`,
      // The exact shape BlogArticlePage's own fetch would have produced.
      preload: [[`blog-article:${slug}:en`, detail]],
    });
  }

  const helpHome = await fetchJson("/public/website/help");
  routeMap.get("/resources").preload = [["help-home:en", helpHome]];
  for (const summary of helpHome.articles ?? []) {
    const path = `/resources/${summary.slug}`;
    const detail = await fetchJson(
      `/public/website/help/articles/${encodeURIComponent(summary.slug)}?locale=en`,
    );
    const article = detail.article ?? detail;
    routeMap.set(path, {
      path,
      title:
        article.seo_title ??
        article.og_title ??
        article.title ??
        summary.title ??
        "Tawseelhub Help Center",
      description:
        article.meta_description ??
        article.og_description ??
        article.summary ??
        summary.summary ??
        "Tawseelhub Help Center guide.",
      canonical: normalizeCanonical(article.canonical_path, path),
      type: "website",
      image: normalizeImageUrl(article.og_image),
      robots: `${article.robots_index === false ? "noindex" : "index"},${article.robots_follow === false ? "nofollow" : "follow"}`,
      preload: [[`help-article:${summary.slug}:en`, detail]],
    });
  }
} catch {
  console.warn(
    "[prerender] Dynamic sitemap feeds unavailable; emitting static public routes only.",
  );
}

const allRoutes = Array.from(routeMap.values());
const template = await readFile("dist/index.html", "utf8");
let bodyRenderFailures = 0;
for (const route of allRoutes) {
  const canonical = route.canonical ?? `${siteUrl}${route.path}`;
  const title = fullTitle(route.title);
  const description = route.description;
  const image = route.image ?? defaultImage;
  const robots = route.robots ? `<meta name="robots" content="${htmlEscape(route.robots)}" />` : "";
  const metadata = `${robots}<link rel="canonical" href="${htmlEscape(canonical)}" /><link rel="alternate" hreflang="en" href="${htmlEscape(`${siteUrl}${route.path}`)}" /><link rel="alternate" hreflang="x-default" href="${htmlEscape(canonical)}" /><meta property="og:title" content="${htmlEscape(title)}" /><meta property="og:description" content="${htmlEscape(description)}" /><meta property="og:type" content="${htmlEscape(route.type ?? "website")}" /><meta property="og:url" content="${htmlEscape(canonical)}" /><meta property="og:image" content="${htmlEscape(image)}" /><meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${htmlEscape(title)}" /><meta name="twitter:description" content="${htmlEscape(description)}" /><meta name="twitter:image" content="${htmlEscape(image)}" />`;
  // Real, visible body content for crawlers and no-JS users: render the
  // exact same <App/> tree the browser mounts, server-side, with any
  // fetched data above handed in so the very first render already has it
  // (see entry-server.tsx / preload-context.ts). A per-route failure here
  // degrades to the empty shell for that one route only -- it never fails
  // the whole build, and the client-side app is completely unaffected
  // either way: main.tsx still does its own independent createRoot render.
  let bodyHtml = "";
  try {
    bodyHtml = render(route.path, new Map(route.preload ?? []));
  } catch (error) {
    bodyRenderFailures += 1;
    console.warn(
      `[prerender] SSR body render failed for ${route.path}:`,
      error instanceof Error ? error.message : error,
    );
  }
  const html = template
    .replace(/<title>.*?<\/title>/, `<title>${htmlEscape(title)}</title>`)
    .replace(
      /<meta name="description" content=".*?" \/>/,
      `<meta name="description" content="${htmlEscape(description)}" />${metadata}`,
    )
    .replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);
  const targetDirectory = route.path === "/" ? "dist" : join("dist", route.path.slice(1));
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(targetDirectory, "index.html"), html);
}
if (bodyRenderFailures > 0) {
  console.warn(
    `[prerender] ${bodyRenderFailures} of ${allRoutes.length} routes fell back to an empty body shell.`,
  );
}

const sitemapPaths = allRoutes
  .map((route) => route.path)
  .filter((path) => path !== "/traders/register");
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map((path) => `  <url><loc>${siteUrl}${path}</loc></url>`).join("\n")}\n</urlset>\n`;
await writeFile("dist/sitemap.xml", sitemap);
