import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const directory = join(fileURLToPath(new URL(".", import.meta.url)), "dist");
const apiBase = (
  process.env.PUBLIC_API_BASE_URL ??
  process.env.VITE_API_BASE_URL ??
  "http://127.0.0.1:3000/api/v1"
).replace(/\/$/, "");
const canonicalOrigin = "https://tawseelhub.com";
const production = process.env.PUBLIC_SEO_ENVIRONMENT === "production";
export const normalizePath = (pathname) =>
  pathname === "/" ? "/" : `/${pathname.replace(/^\/+|\/+$/g, "")}`;
export const isOriginHost = (host) => /\.onrender\.com(?::\d+)?$/i.test(host);
export const robotsHeader = (host) =>
  production && !isOriginHost(host) ? undefined : "noindex, nofollow";
export const isPrivateIndexingPath = (pathname, searchParams = new URLSearchParams()) => {
  const publicPath = pathname.startsWith("/ar/") ? pathname.slice(3) : pathname;
  return (
    /^(\/track|\/send-a-package\/quote)(\/|$)/.test(publicPath) ||
    (publicPath === "/resources" && searchParams.has("q"))
  );
};
export const injectRobotsDirective = (html, directive) => {
  const meta = `<meta name="robots" content="${escape(directive)}" />`;
  if (/<meta name="robots"[^>]*>/i.test(html))
    return html.replace(/<meta name="robots"[^>]*>/gi, meta);
  return html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : html;
};
export const cacheControlFor = (pathname, type) =>
  pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : type.startsWith("text/html")
      ? "public, max-age=60, stale-while-revalidate=300"
      : "public, max-age=86400";
export function encodedBody(body, type, acceptEncoding = "") {
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (source.length < 1024 || !/^(text\/|application\/(?:javascript|json|xml|rss\+xml))/.test(type))
    return { body: source };
  if (/\bbr\b/.test(acceptEncoding)) return { body: brotliCompressSync(source), encoding: "br" };
  if (/\bgzip\b/.test(acceptEncoding)) return { body: gzipSync(source), encoding: "gzip" };
  return { body: source };
}
function send(response, status, headers, body, acceptEncoding = "") {
  const encoded = encodedBody(body, headers["content-type"] ?? "", acceptEncoding);
  response.writeHead(status, {
    ...headers,
    ...(encoded.encoding ? { "content-encoding": encoded.encoding, vary: "Accept-Encoding" } : {}),
  });
  response.end(encoded.body);
}
const types = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};
export const sitemapStylesheet = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <title>Tawseelhub XML Sitemap</title>
        <style>
          body{font-family:Inter,Arial,sans-serif;margin:32px;color:#172033;background:#f8fafc}
          h1{margin:0 0 8px;font-size:28px}
          p{margin:0 0 24px;color:#526071}
          table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dbe3ef;border-radius:12px;overflow:hidden}
          th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #e5ebf3;vertical-align:top}
          th{background:#edf4ff;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#334155}
          tr:last-child td{border-bottom:0}
          a{color:#0f766e;text-decoration:none}
          a:hover{text-decoration:underline}
          .muted{color:#64748b;font-size:13px}
          .hreflang{display:inline-block;margin:0 6px 6px 0;padding:3px 7px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px}
        </style>
      </head>
      <body>
        <h1>Tawseelhub XML Sitemap</h1>
        <p>This sitemap is formatted for humans. Search engines read the XML data underneath.</p>
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Last modified</th>
              <th>Alternate languages</th>
            </tr>
          </thead>
          <tbody>
            <xsl:for-each select="sitemap:urlset/sitemap:url">
              <tr>
                <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
                <td class="muted"><xsl:value-of select="sitemap:lastmod"/></td>
                <td>
                  <xsl:for-each select="xhtml:link">
                    <span class="hreflang">
                      <xsl:value-of select="@hreflang"/>
                    </span>
                  </xsl:for-each>
                </td>
              </tr>
            </xsl:for-each>
          </tbody>
        </table>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
`;
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const safeJson = (value) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
const assetUrl = (value) =>
  !value
    ? ""
    : /^https:\/\//i.test(value)
      ? value
      : value.startsWith("/api/")
        ? `${apiBase.replace(/\/api\/v1$/, "")}${value}`
        : `${canonicalOrigin}${value.startsWith("/") ? value : `/${value}`}`;
const organizationSchema = {
  "@type": "Organization",
  "@id": `${canonicalOrigin}/#organization`,
  name: "Tawseelhub",
  url: `${canonicalOrigin}/`,
  description:
    "Tawseelhub provides a delivery operating system for modern delivery companies in the UAE.",
  telephone: "+971506898604",
  areaServed: { "@type": "Country", name: "United Arab Emirates" },
  address: {
    "@type": "PostalAddress",
    streetAddress: "Shop No. 9, Freej Avenue, Al Hamidiya",
    addressLocality: "Ajman",
    addressCountry: "AE",
  },
};
const websiteSchema = {
  "@type": "WebSite",
  "@id": `${canonicalOrigin}/#website`,
  url: `${canonicalOrigin}/`,
  name: "Tawseelhub",
  publisher: { "@id": `${canonicalOrigin}/#organization` },
  inLanguage: ["en", "ar"],
};
const softwareSchema = {
  "@type": "SoftwareApplication",
  "@id": `${canonicalOrigin}/#software`,
  name: "Tawseelhub",
  url: `${canonicalOrigin}/`,
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Delivery Management Software",
  operatingSystem: "Web",
  description:
    "Tawseelhub is a delivery operating system for UAE delivery companies that helps manage orders, drivers, COD collections, trader settlements, accounting, payroll, reporting and connected sales channels.",
  areaServed: { "@type": "Country", name: "United Arab Emirates" },
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "AED",
    description: "Free plan for up to 100 orders per month.",
  },
  publisher: { "@id": `${canonicalOrigin}/#organization` },
};
const homeFaqs = [
  [
    "What is Tawseelhub?",
    "Tawseelhub is a delivery operating system built for UAE delivery companies, helping them manage orders, drivers, cash on delivery (COD), trader settlements, accounting, and payroll in one platform.",
  ],
  [
    "Who is Tawseelhub designed for?",
    "Tawseelhub is built for delivery and courier companies, last-mile logistics providers, and businesses managing their own fleet of delivery drivers across the UAE.",
  ],
  [
    "Can Tawseelhub handle Cash on Delivery (COD) management?",
    "Yes. Tawseelhub tracks COD collections from drivers, reconciles cash against orders, and helps prevent discrepancies in real time.",
  ],
  [
    "Does Tawseelhub support driver management?",
    "Yes. Tawseelhub includes tools to assign orders, track driver performance, monitor deliveries, and manage driver payroll.",
  ],
  [
    "What is trader settlement in Tawseelhub?",
    "Trader settlement refers to reconciling and paying merchants or traders whose orders were delivered. Tawseelhub supports calculation and payout tracking.",
  ],
  [
    "Does Tawseelhub include accounting features?",
    "Yes. Tawseelhub includes accounting functions so delivery companies can track revenue, expenses, and settlements.",
  ],
  [
    "Can I manage driver payroll through Tawseelhub?",
    "Yes. Payroll management is built into Tawseelhub and can factor in deliveries completed, COD handled, and other performance metrics.",
  ],
  [
    "Is Tawseelhub only for large delivery companies?",
    "No. Tawseelhub is designed to scale for both small and large delivery operations across the UAE.",
  ],
  [
    "Does Tawseelhub offer real-time order tracking?",
    "Yes. Businesses and their customers can track order status from dispatch to delivery.",
  ],
  [
    "Is Tawseelhub cloud-based?",
    "Yes. Tawseelhub operates as a cloud-based platform accessible from anywhere without heavy on-premise infrastructure.",
  ],
  [
    "Can Tawseelhub integrate with existing e-commerce systems?",
    "Yes. Tawseelhub's Trader Portal is built to connect order intake from sales channels such as Salla, Shopify and WooCommerce.",
  ],
  [
    "What UAE cities does Tawseelhub support?",
    "Tawseelhub supports delivery companies across the UAE, including Dubai, Abu Dhabi, Sharjah and Ajman.",
  ],
  [
    "Is there a free trial or demo available?",
    "Yes. You can request a demo, and the Free plan gives access for up to 100 orders per month.",
  ],
  [
    "How much does Tawseelhub cost?",
    "Tawseelhub starts free for up to 100 orders per month. Paid plans are available based on monthly order volume.",
  ],
];
const breadcrumbSchema = (path, name) => ({
  "@type": "BreadcrumbList",
  "@id": `${canonicalOrigin}${path}#breadcrumb`,
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: `${canonicalOrigin}/` },
    ...(path === "/"
      ? []
      : [{ "@type": "ListItem", position: 2, name, item: `${canonicalOrigin}${path}` }]),
  ],
});
const webpageSchema = ({ path, type = "WebPage", name, description, mainEntity, about }) => ({
  "@type": type,
  "@id": `${canonicalOrigin}${path === "/" ? "/" : path}#webpage`,
  url: `${canonicalOrigin}${path}`,
  name,
  description,
  inLanguage: "en",
  isPartOf: { "@id": `${canonicalOrigin}/#website` },
  publisher: { "@id": `${canonicalOrigin}/#organization` },
  ...(about ? { about: { "@id": about } } : {}),
  ...(mainEntity ? { mainEntity: { "@id": mainEntity } } : {}),
  breadcrumb: { "@id": `${canonicalOrigin}${path}#breadcrumb` },
});
const serviceSchema = ({ path, id, name, serviceType, description, audience }) => ({
  "@type": "Service",
  "@id": `${canonicalOrigin}${path}#${id}`,
  name,
  serviceType,
  description,
  provider: { "@id": `${canonicalOrigin}/#organization` },
  areaServed: { "@type": "Country", name: "United Arab Emirates" },
  ...(audience ? { audience: { "@type": "BusinessAudience", audienceType: audience } } : {}),
  url: `${canonicalOrigin}${path}`,
});
const itemListSchema = ({ path, id, name, items }) => ({
  "@type": "ItemList",
  "@id": `${canonicalOrigin}${path}#${id}`,
  name,
  numberOfItems: items.length,
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    ...(typeof item === "string" ? { name: item } : item),
  })),
});
export function structuredDataForPath(pathname) {
  if (pathname === "/ar" || pathname.startsWith("/ar/")) return undefined;
  const path = pathname;
  if (path === "/") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        softwareSchema,
        organizationSchema,
        websiteSchema,
        webpageSchema({
          path: "/",
          name: "Delivery Operating System for Delivery Companies | Tawseelhub",
          description:
            "Tawseelhub is a delivery operating system for UAE delivery companies, connecting orders, drivers, COD collections, trader settlements, accounting, payroll, reporting and commerce integrations.",
          about: `${canonicalOrigin}/#software`,
          mainEntity: `${canonicalOrigin}/#software`,
        }),
        {
          "@type": "FAQPage",
          "@id": `${canonicalOrigin}/#faq`,
          url: `${canonicalOrigin}/`,
          mainEntity: homeFaqs.map(([name, text]) => ({
            "@type": "Question",
            name,
            acceptedAnswer: { "@type": "Answer", text },
          })),
        },
        breadcrumbSchema("/", "Home"),
      ],
    };
  }
  const routes = {
    "/delivery-companies": () => {
      const serviceId = `${canonicalOrigin}/delivery-companies#service`;
      return [
        webpageSchema({
          path,
          name: "Delivery Management Software UAE | Tawseelhub Delivery Operating System",
          description:
            "Tawseelhub helps UAE delivery companies manage orders, drivers, COD collections, trader settlements, accounting, payroll, reporting and connected sales channels from one operating system.",
          about: serviceId,
          mainEntity: serviceId,
        }),
        serviceSchema({
          path,
          id: "service",
          name: "Delivery Management Software for Delivery Companies",
          serviceType: "Delivery Management Software",
          description:
            "A complete operating system for delivery companies to manage orders, drivers, COD collections, trader relationships, settlements, accounting, payroll, reporting and connected commerce channels.",
          audience: "Delivery Companies",
        }),
        itemListSchema({
          path,
          id: "features",
          name: "Tawseelhub Delivery Company Features",
          items: [
            "Orders",
            "Driver Operations",
            "COD & Collections",
            "Trader Management",
            "Trader Settlements",
            "Accounting",
            "Payroll",
            "Reports",
            "Mobile Operations",
            "Integrations",
          ],
        }),
        breadcrumbSchema(path, "Delivery Companies"),
      ];
    },
    "/send-a-package": () => {
      const serviceId = `${canonicalOrigin}/send-a-package#service`;
      return [
        webpageSchema({
          path,
          name: "Send a Package Across the UAE | Tawseelhub",
          description:
            "Get a delivery quotation with Tawseelhub for UAE domestic, UAE-to-international, international-to-UAE and international-to-international package shipments.",
          about: serviceId,
          mainEntity: serviceId,
        }),
        {
          ...serviceSchema({
            path,
            id: "service",
            name: "Package Delivery Quotation",
            serviceType: "Package Delivery",
            description:
              "Tawseelhub provides delivery quotation requests for UAE domestic, UAE-to-international, international-to-UAE and international-to-international shipments.",
          }),
          areaServed: [
            { "@type": "Country", name: "United Arab Emirates" },
            { "@type": "Place", name: "International" },
          ],
        },
        itemListSchema({
          path,
          id: "features",
          name: "Package Delivery Quote Options",
          items: [
            "Instant pricing for configured UAE routes",
            "International quote capture",
            "COD for UAE domestic routes",
            "Guest quote without an account",
            "Custom review for unusual shipments",
          ],
        }),
        breadcrumbSchema(path, "Send a Package"),
      ];
    },
    "/traders": () => {
      const serviceId = `${canonicalOrigin}/traders#service`;
      return [
        webpageSchema({
          path,
          name: "Delivery Solutions for Traders & Online Sellers UAE | Tawseelhub",
          description:
            "Tawseelhub connects traders and online sellers in the UAE to structured delivery operations, order management, commerce integrations, delivery companies and settlement visibility.",
          about: serviceId,
          mainEntity: serviceId,
        }),
        serviceSchema({
          path,
          id: "service",
          name: "Delivery Solutions for Traders & Online Sellers",
          serviceType: "Trader Delivery Management",
          description:
            "Tawseelhub helps traders and online sellers manage delivery orders, track order history and status, connect commerce channels, work with delivery companies and view settlement information.",
          audience: ["Traders", "Online Sellers", "E-commerce Businesses"],
        }),
        itemListSchema({
          path,
          id: "features",
          name: "Tawseelhub Trader Features",
          items: [
            "Manage Delivery Orders",
            "Track Order History & Status",
            "Connect Existing Commerce Channels",
            "Connect Your Existing Delivery Company",
            "Find a Delivery Company",
            "Settlement Visibility",
          ],
        }),
        breadcrumbSchema(path, "Traders"),
      ];
    },
    "/pricing": () => [
      webpageSchema({
        path,
        name: "Tawseelhub Pricing | AED Plans for Delivery Companies",
        description:
          "Explore Tawseelhub delivery operating system plans based on monthly order volume, including Free, Starter, Growth and Business plans.",
        about: `${canonicalOrigin}/#software`,
        mainEntity: `${canonicalOrigin}/pricing#plans`,
      }),
      itemListSchema({
        path,
        id: "plans",
        name: "Tawseelhub Pricing Plans",
        items: [
          ["Free", "0", "Up to 100 orders per month."],
          ["Starter", "500", "100 to 2,000 orders per month."],
          ["Growth", "1000", "2,001 to 5,000 orders per month."],
          ["Business", "2000", "5,001 to 10,000 orders per month."],
        ].map(([name, price, description]) => ({
          name: `${name} Plan`,
          item: {
            "@type": "Offer",
            "@id": `${canonicalOrigin}/pricing#${name.toLowerCase()}`,
            name,
            price,
            priceCurrency: "AED",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price,
              priceCurrency: "AED",
              unitText: "MONTH",
            },
            description,
            url: `${canonicalOrigin}/pricing`,
          },
        })),
      }),
      breadcrumbSchema(path, "Pricing"),
    ],
    "/traders/register": () => [
      webpageSchema({
        path,
        name: "Trader Registration | Tawseelhub",
        description:
          "Register your business with Tawseelhub to connect your business to delivery operations in the UAE.",
        mainEntity: `${canonicalOrigin}/traders/register#application`,
      }),
      {
        "@type": "WebApplication",
        "@id": `${canonicalOrigin}/traders/register#application`,
        name: "Tawseelhub Trader Registration",
        url: `${canonicalOrigin}/traders/register`,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Business Registration",
        operatingSystem: "Web",
        description:
          "Online trader application form for businesses that want to register with Tawseelhub and connect their business to delivery operations.",
        provider: { "@id": `${canonicalOrigin}/#organization` },
        areaServed: { "@type": "Country", name: "United Arab Emirates" },
        inLanguage: "en",
      },
      {
        ...breadcrumbSchema(path, "Register as Trader"),
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${canonicalOrigin}/` },
          {
            "@type": "ListItem",
            position: 2,
            name: "Traders",
            item: `${canonicalOrigin}/traders`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: "Register as Trader",
            item: `${canonicalOrigin}/traders/register`,
          },
        ],
      },
    ],
    "/integrations": () => {
      const serviceId = `${canonicalOrigin}/integrations#service`;
      return [
        webpageSchema({
          path,
          name: "Commerce Integrations | Tawseelhub",
          description:
            "Connect Salla, Shopify and WooCommerce orders with Tawseelhub to streamline order intake and delivery operations without manual re-entry.",
          mainEntity: serviceId,
        }),
        serviceSchema({
          path,
          id: "service",
          name: "Commerce Integrations",
          serviceType: "E-commerce Order Integration",
          description:
            "Commerce integration service designed to connect Trader orders from Salla, Shopify and WooCommerce with Tawseelhub delivery operations.",
          audience: "Delivery Companies and Online Traders",
        }),
        itemListSchema({
          path,
          id: "platforms",
          name: "Tawseelhub Commerce Integrations",
          items: ["Salla", "Shopify", "WooCommerce"].map((name) => ({
            name,
            item: {
              "@type": "SoftwareApplication",
              name,
              applicationCategory: "E-commerce Platform",
            },
          })),
        }),
        breadcrumbSchema(path, "Integrations"),
      ];
    },
    "/request-demo": () => [
      webpageSchema({
        path,
        name: "Request a Tawseelhub Demo",
        description:
          "Request a tailored Tawseelhub demo for your delivery company and see how orders, drivers, COD collections, trader settlements, accounting and reporting work together.",
        mainEntity: `${canonicalOrigin}/request-demo#demo-request`,
      }),
      {
        "@type": "WebApplication",
        "@id": `${canonicalOrigin}/request-demo#demo-request`,
        name: "Tawseelhub Demo Request",
        url: `${canonicalOrigin}/request-demo`,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Demo Request",
        operatingSystem: "Web",
        description:
          "Online demo request form for delivery companies that want to evaluate Tawseelhub.",
        provider: { "@id": `${canonicalOrigin}/#organization` },
        areaServed: { "@type": "Country", name: "United Arab Emirates" },
      },
      breadcrumbSchema(path, "Request Demo"),
    ],
    "/about": () => [
      webpageSchema({
        path,
        type: "AboutPage",
        name: "About Tawseelhub",
        description:
          "Learn why Tawseelhub is building a connected delivery operating system for delivery businesses in the UAE.",
        mainEntity: `${canonicalOrigin}/#organization`,
      }),
      organizationSchema,
      breadcrumbSchema(path, "About"),
    ],
    "/contact": () => [
      webpageSchema({
        path,
        type: "ContactPage",
        name: "Contact Tawseelhub",
        description:
          "Contact Tawseelhub to discuss your delivery operation, request a tailored product demonstration or send a product enquiry.",
        mainEntity: `${canonicalOrigin}/#organization`,
      }),
      organizationSchema,
      breadcrumbSchema(path, "Contact"),
    ],
    "/privacy": () => [
      webpageSchema({
        path,
        type: "PrivacyPolicy",
        name: "Privacy Policy | Tawseelhub",
        description:
          "Tawseelhub privacy policy covering information collection, use of information, data sharing, data retention and user rights.",
        mainEntity: `${canonicalOrigin}/privacy#webpage`,
      }),
      breadcrumbSchema(path, "Privacy Policy"),
    ],
    "/terms": () => [
      webpageSchema({
        path,
        type: "TermsOfService",
        name: "Terms of Service | Tawseelhub",
        description:
          "Terms of Service for using the Tawseelhub website and delivery operating system, including service description, account responsibilities, limitation of liability, governing law and changes to terms.",
        mainEntity: `${canonicalOrigin}/terms#webpage`,
      }),
      breadcrumbSchema(path, "Terms of Service"),
    ],
    "/faq": () => [
      webpageSchema({
        path,
        name: "Frequently Asked Questions | Tawseelhub",
        description:
          "Answers about Tawseelhub delivery management software for the UAE — COD reconciliation, driver management, trader settlements, accounting, payroll and pricing.",
        mainEntity: `${canonicalOrigin}/faq#faq`,
      }),
      {
        "@type": "FAQPage",
        "@id": `${canonicalOrigin}/faq#faq`,
        url: `${canonicalOrigin}/faq`,
        mainEntity: homeFaqs.map(([name, text]) => ({
          "@type": "Question",
          name,
          acceptedAnswer: { "@type": "Answer", text },
        })),
      },
      breadcrumbSchema(path, "FAQs"),
    ],
  };
  const build = routes[path];
  if (!build) return undefined;
  return {
    "@context": "https://schema.org",
    "@graph": [organizationSchema, websiteSchema, ...build()],
  };
}
export function injectStaticPageMetadata(html, pathname) {
  const graph = structuredDataForPath(pathname);
  if (!graph) return html;
  const cleaned = html.replace(
    /<script type="application\/ld\+json"[^>]*data-static-schema="true"[^>]*>[\s\S]*?<\/script>/g,
    "",
  );
  const script = `<script type="application/ld+json" data-static-schema="true">${safeJson(graph)}</script>`;
  return cleaned.includes("</head>") ? cleaned.replace("</head>", `${script}</head>`) : cleaned;
}
async function api(path) {
  const response = await fetch(`${apiBase}${path}`, { headers: { accept: "application/json" } });
  return response.ok ? response.json() : undefined;
}
export function injectArticleMetadata(html, article, pathname) {
  const seo = article.seo ?? {};
  const canonical = seo.canonical || article.canonical_url || `${canonicalOrigin}${pathname}`;
  const title = seo.title || article.social_title || article.seo_title || article.title;
  const description =
    seo.description || article.social_description || article.meta_description || article.excerpt;
  const image = assetUrl(
    seo.image || article.social_image_url || article.featured_image_public_url,
  );
  const robots = `${article.robots_index ? "index" : "noindex"},${article.robots_follow ? "follow" : "nofollow"},max-image-preview:large`;
  const imageMetadata = image
    ? `<meta property="og:image" content="${escape(image)}" />${seo.imageAlt ? `<meta property="og:image:alt" content="${escape(seo.imageAlt)}" /><meta name="twitter:image:alt" content="${escape(seo.imageAlt)}" />` : ""}${seo.imageWidth ? `<meta property="og:image:width" content="${seo.imageWidth}" />` : ""}${seo.imageHeight ? `<meta property="og:image:height" content="${seo.imageHeight}" />` : ""}<meta name="twitter:image" content="${escape(image)}" />`
    : "";
  const alternates =
    (seo.alternates ?? [{ language: article.language === "ar" ? "ar" : "en", url: canonical }])
      .map(
        (item) =>
          `<link rel="alternate" hreflang="${escape(item.language)}" href="${escape(item.url)}" />`,
      )
      .join("") +
    (seo.xDefault
      ? `<link rel="alternate" hreflang="x-default" href="${escape(seo.xDefault)}" />`
      : "") +
    `<link rel="alternate" type="application/rss+xml" title="Tawseelhub Blog RSS" href="${article.language === "ar" ? "/ar" : ""}/blog/rss.xml" />`;
  const metadata = `<meta name="robots" content="${escape(robots)}" /><link rel="canonical" href="${escape(canonical)}" />${alternates}<meta property="og:type" content="article" /><meta property="og:title" content="${escape(title)}" /><meta property="og:description" content="${escape(description)}" /><meta property="og:url" content="${escape(canonical)}" /><meta property="og:site_name" content="Tawseelhub" /><meta property="og:locale" content="${article.language === "ar" ? "ar_AE" : "en_AE"}" />${seo.alternateLocale ? `<meta property="og:locale:alternate" content="${escape(seo.alternateLocale)}" />` : ""}${imageMetadata}<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" /><meta name="twitter:title" content="${escape(title)}" /><meta name="twitter:description" content="${escape(description)}" />${seo.graph ? `<script type="application/ld+json" data-seo-schema="true">${safeJson(seo.graph)}</script>` : ""}`;
  const cleaned = html
    .replace(/<link rel="canonical"[^>]*>/g, "")
    .replace(/<link rel="alternate"[^>]*>/g, "")
    .replace(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g, "")
    .replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, "");
  return cleaned
    .replace(
      /<html lang="[^"]+"(?: dir="[^"]+")?>/,
      article.language === "ar" ? '<html lang="ar" dir="rtl">' : '<html lang="en" dir="ltr">',
    )
    .replace(/<title>.*?<\/title>/, `<title>${escape(title)} | Tawseelhub</title>`)
    .replace(
      /<meta name="description" content=".*?" \/>/,
      `<meta name="description" content="${escape(description)}" />${metadata}`,
    );
}
export function injectLandingMetadata(html, landing) {
  const seo = landing.seo ?? {},
    title = seo.title ?? landing.name ?? landing.title ?? landing.display_name,
    description = seo.description ?? landing.description ?? landing.short_bio ?? "",
    canonical = seo.canonical;
  const alternates =
    (seo.alternates ?? [])
      .map(
        (item) =>
          `<link rel="alternate" hreflang="${escape(item.language)}" href="${escape(item.url)}" />`,
      )
      .join("") +
    (seo.xDefault
      ? `<link rel="alternate" hreflang="x-default" href="${escape(seo.xDefault)}" />`
      : "");
  const metadata = `<meta name="robots" content="${landing.robots_index ? "index" : "noindex"},${landing.robots_follow === false ? "nofollow" : "follow"},max-image-preview:large" /><link rel="canonical" href="${escape(canonical)}" />${alternates}<link rel="alternate" type="application/rss+xml" title="Tawseelhub Blog RSS" href="${landing.language === "ar" ? "/ar" : ""}/blog/rss.xml" /><meta property="og:type" content="website" /><meta property="og:title" content="${escape(title)}" /><meta property="og:description" content="${escape(description)}" /><meta property="og:url" content="${escape(canonical)}" />${seo.graph ? `<script type="application/ld+json" data-seo-schema="true">${safeJson(seo.graph)}</script>` : ""}`;
  return html
    .replace(/<link rel="canonical"[^>]*>/g, "")
    .replace(/<link rel="alternate"[^>]*>/g, "")
    .replace(/<meta name="robots"[^>]*>/g, "")
    .replace(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g, "")
    .replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<title>.*?<\/title>/, `<title>${escape(title)} | Tawseelhub</title>`)
    .replace(
      /<meta name="description" content=".*?" \/>/,
      `<meta name="description" content="${escape(description)}" />${metadata}`,
    );
}

export function renderHelpArticleShell(article, related = []) {
  const language = article.locale === "ar" ? "ar" : "en";
  const dir = language === "ar" ? "rtl" : "ltr";
  const blocks = (article.body ?? []).map(articleBlockHtml).join("");
  const relatedHtml = related.length
    ? `<aside class="related-guides"><h2>${language === "ar" ? "أدلة ذات صلة" : "Related guides"}</h2>${related.map((item) => `<a href="${language === "ar" ? "/ar" : ""}/resources/${escape(item.slug)}">${escape(item.title)}</a>`).join("")}</aside>`
    : "";
  return `<article class="section help-article${language === "ar" ? " help-article--rtl" : ""}" dir="${dir}" lang="${language}"><a class="text-link" href="${language === "ar" ? "/ar" : ""}/resources">← ${language === "ar" ? "مركز المساعدة" : "Help Center"}</a><header><span>${escape(article.categoryName ?? "")}</span><h1>${escape(article.title)}</h1><p>${escape(article.summary)}</p></header><div class="help-article-body">${blocks}</div>${relatedHtml}</article>`;
}

export function renderHelpHomeShell(payload) {
  const language = payload?.locale === "ar" ? "ar" : "en";
  const dir = language === "ar" ? "rtl" : "ltr";
  const articles = (payload?.articles ?? [])
    .map((article) => {
      const prefix = article.locale === "ar" ? "/ar" : "";
      return `<article class="help-result-card"><span>${escape(article.categoryName ?? article.categorySlug ?? (language === "ar" ? "دليل" : "Guide"))}</span><h2><a href="${prefix}/resources/${escape(article.slug)}">${escape(article.title)}</a></h2><p>${escape(article.summary)}</p><a class="text-link" href="${prefix}/resources/${escape(article.slug)}">${language === "ar" ? "اقرأ الدليل" : "Read guide"} →</a></article>`;
    })
    .join("");
  return `<section class="section resources-page" dir="${dir}" lang="${language}"><header><span>${language === "ar" ? "مركز المساعدة" : "Help Center"}</span><h1>${language === "ar" ? "أدلة وإجابات Tawseelhub" : "Tawseelhub guides and answers"}</h1><p>${language === "ar" ? "أدلة عملية للطلبات والسائقين والتحصيل والتقارير والتكاملات والدعم." : "Practical guides for orders, drivers, COD collections, reports, integrations and support."}</p></header><div class="help-results">${articles}</div></section>`;
}

export function injectHelpArticleMetadata(html, article, pathname) {
  const canonicalPath = article.canonical_path || pathname;
  const canonical = /^https?:\/\//i.test(canonicalPath)
    ? canonicalPath
    : `${canonicalOrigin}${canonicalPath.startsWith("/") ? canonicalPath : `/${canonicalPath}`}`;
  return injectArticleMetadata(
    html,
    {
      language: article.locale === "ar" ? "ar" : "en",
      title: article.title,
      excerpt: article.summary,
      seo_title: article.seo_title,
      meta_description: article.meta_description,
      canonical_url: canonical,
      robots_index: article.robots_index !== false,
      robots_follow: article.robots_follow !== false,
      seo: {
        canonical,
        title: article.seo_title ?? article.title,
        description: article.meta_description ?? article.summary,
      },
    },
    pathname,
  ).replace('property="og:type" content="article"', 'property="og:type" content="website"');
}
async function fileResponse(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = normalize(join(directory, relative));
  if (!candidate.startsWith(directory)) return undefined;
  try {
    const info = await stat(candidate);
    const file = info.isDirectory() ? join(candidate, "index.html") : candidate;
    return { body: await readFile(file), type: types[extname(file)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}
export function injectRenderedRoot(html, rendered) {
  const body = String(rendered ?? "");
  const rootStart = html.indexOf('<div id="root"');
  if (rootStart < 0) return html;
  const rootOpenEnd = html.indexOf(">", rootStart);
  if (rootOpenEnd < 0) return html;
  const scriptStart = html.indexOf('<script type="module"', rootOpenEnd);
  if (scriptStart >= 0)
    return `${html.slice(0, rootStart)}<div id="root">${body}</div>\n    ${html.slice(scriptStart)}`;
  const bodyEnd = html.indexOf("</body>", rootOpenEnd);
  if (bodyEnd >= 0)
    return `${html.slice(0, rootStart)}<div id="root">${body}</div>${html.slice(bodyEnd)}`;
  return html.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${body}</div>`);
}
function articleBlockHtml(block) {
  const text = block?.text ?? "";
  if (block?.type === "html") return text;
  if (block?.type === "h2") return `<h2>${escape(text)}</h2>`;
  if (block?.type === "h3") return `<h3>${escape(text)}</h3>`;
  if (block?.type === "blockquote") return `<blockquote>${escape(text)}</blockquote>`;
  if (block?.type === "bullet_list")
    return `<ul>${(block.items ?? []).map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`;
  if (block?.type === "numbered_list")
    return `<ol>${(block.items ?? []).map((item) => `<li>${escape(item)}</li>`).join("")}</ol>`;
  return `<p>${escape(text)}</p>`;
}
export function renderArticleShell(article, related = []) {
  const language = article.language === "ar" ? "ar" : "en";
  const dir = language === "ar" ? "rtl" : "ltr";
  const categorySlug = article.category_slug ?? "";
  const image = assetUrl(article.featured_image_public_url);
  const tags = (article.tags ?? [])
    .map(
      (tag) =>
        `<a href="${language === "ar" ? "/ar" : ""}/blog/tag/${escape(tag.slug)}">#${escape(tag.name)}</a>`,
    )
    .join("");
  const blocks = (article.content ?? []).map(articleBlockHtml).join("");
  const relatedHtml = related.length
    ? `<section class="related-articles"><h2>${language === "ar" ? "مقالات ذات صلة" : "Related articles"}</h2>${related.map((item) => `<article><h3><a href="${language === "ar" ? "/ar" : ""}/blog/${escape(item.slug)}">${escape(item.title)}</a></h3><p>${escape(item.excerpt ?? "")}</p></article>`).join("")}</section>`
    : "";
  return `<article class="article-page" dir="${dir}" lang="${language}"><nav aria-label="Breadcrumb"><a href="${language === "ar" ? "/ar" : "/"}">${language === "ar" ? "الرئيسية" : "Home"}</a> / <a href="${language === "ar" ? "/ar" : ""}/blog">${language === "ar" ? "المدونة" : "Blog"}</a> / <a href="${language === "ar" ? "/ar" : ""}/blog/category/${escape(categorySlug)}">${escape(article.category ?? "")}</a></nav><header><span>${escape(article.category ?? "")}</span><h1>${escape(article.title)}</h1><p>${escape(article.excerpt)}</p></header>${tags ? `<nav class="blog-categories" aria-label="Article tags">${tags}</nav>` : ""}${image ? `<img class="article-image" src="${escape(image)}" alt="${escape(article.featured_image_alt ?? "")}" width="${article.featured_image_width ?? 1200}" height="${article.featured_image_height ?? 675}" loading="eager" decoding="async" fetchpriority="high" />` : ""}<div class="article-layout"><div class="article-body">${blocks}</div><aside><h2>${language === "ar" ? "استكشف Tawseelhub" : "Explore Tawseelhub"}</h2><a href="${language === "ar" ? "/ar" : ""}/delivery-companies">${language === "ar" ? "منصة شركة التوصيل" : "Delivery Company platform"}</a><a href="${language === "ar" ? "/ar" : ""}/traders">${language === "ar" ? "حلول للتجار" : "Solutions for Traders"}</a><a href="${language === "ar" ? "/ar" : ""}/send-a-package">${language === "ar" ? "أرسل شحنة" : "Send a Package"}</a></aside></div>${relatedHtml}</article>`;
}
export function renderGuideShell(guide) {
  const language=guide.language==="ar"?"ar":"en",dir=language==="ar"?"rtl":"ltr";
  const image=assetUrl(guide.featuredImagePublicUrl);
  const blocks=(guide.content??[]).map(articleBlockHtml).join("");
  return `<article class="article-page guide-page" dir="${dir}" lang="${language}"><nav aria-label="Breadcrumb"><a href="${language==="ar"?"/ar":"/"}">${language==="ar"?"الرئيسية":"Home"}</a> / ${escape(guide.title)}</nav><header><span>${language==="ar"?"دليل Tawseelhub":"Tawseelhub Guide"}</span><h1>${escape(guide.title)}</h1><p>${escape(guide.summary)}</p></header>${image?`<img class="article-image" src="${escape(image)}" alt="${escape(guide.featuredImageAlt??"")}" loading="eager" decoding="async" fetchpriority="high" />`:""}<div class="article-layout"><div class="article-body">${blocks}</div></div></article>`;
}
export function helpArticleRequestForPath(pathname) {
  const match = pathname.match(/^(\/ar)?\/resources\/([^/]+)$/);
  if (!match) return undefined;
  return {
    slug: match[2],
    locale: match[1] ? "ar" : "en",
    apiPath: `/public/website/help/articles/${encodeURIComponent(match[2])}?locale=${
      match[1] ? "ar" : "en"
    }`,
  };
}
export function blogLandingRequestForPath(pathname) {
  const match = pathname.match(/^(\/ar)?\/blog\/(category|tag|topic|author)\/([^/]+)$/);
  if (!match) return undefined;
  const collection = {
    category: "categories",
    tag: "tags",
    topic: "topics",
    author: "authors",
  }[match[2]];
  const language = match[1] ? "ar" : "en";
  return {
    kind: match[2],
    slug: match[3],
    language,
    apiPath: `/public/blog/${collection}/${encodeURIComponent(match[3])}?language=${language}`,
  };
}
export function createPublicServer() {
  return createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "localhost";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const pathname = normalizePath(url.pathname);
      if (pathname === "/healthz") {
        response
          .writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          .end('{"status":"ok"}');
        return;
      }
      if (production && /^www\.tawseelhub\.com(?::\d+)?$/i.test(host)) {
        response.writeHead(308, { location: `${canonicalOrigin}${pathname}${url.search}` }).end();
        return;
      }
      if (url.pathname !== pathname && url.pathname !== "/") {
        response.writeHead(308, { location: `${pathname}${url.search}` }).end();
        return;
      }
      if (url.searchParams.has("lang")) {
        url.searchParams.delete("lang");
        const search = url.searchParams.toString();
        response.writeHead(308, { location: `${pathname}${search ? `?${search}` : ""}` }).end();
        return;
      }
      const privatePath = isPrivateIndexingPath(pathname, url.searchParams);
      const noindex = privatePath ? "noindex, follow" : robotsHeader(host);
      if (noindex) response.setHeader("X-Robots-Tag", noindex);
      if (pathname.startsWith("/api/")) {
        const upstream = await fetch(
          `${apiBase.replace(/\/api\/v1$/, "")}${pathname}${url.search}`,
          { method: request.method, headers: { accept: request.headers.accept ?? "*/*" } },
        );
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": upstream.headers.get("cache-control") ?? "public, max-age=60",
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      if (pathname === "/sitemap.xsl") {
        send(
          response,
          200,
          {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
          sitemapStylesheet,
          request.headers["accept-encoding"],
        );
        return;
      }
      if (pathname === "/sitemap.xml") {
        const upstream = await fetch(`${apiBase}/public/website/sitemap.xml`);
        send(
          response,
          upstream.status,
          {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=60, stale-while-revalidate=300",
          },
          Buffer.from(await upstream.arrayBuffer()),
          request.headers["accept-encoding"],
        );
        return;
      }
      if (/^(\/ar)?\/blog\/rss\.xml$/.test(pathname)) {
        const upstream = await fetch(
          `${apiBase}/public/blog/rss.xml?language=${pathname.startsWith("/ar/") ? "ar" : "en"}`,
        );
        send(
          response,
          upstream.status,
          {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=300, stale-while-revalidate=900",
          },
          Buffer.from(await upstream.arrayBuffer()),
          request.headers["accept-encoding"],
        );
        return;
      }
      if (pathname === "/robots.txt" && isOriginHost(host)) {
        response
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("User-agent: *\nDisallow: /\n");
        return;
      }
      const landingRequest = blogLandingRequestForPath(pathname);
      let landing;
      if (landingRequest) {
        landing = await api(landingRequest.apiPath);
        if (!landing) {
          const redirect = await api(`/public/blog/redirect?path=${encodeURIComponent(pathname)}`);
          if (redirect?.to) {
            response
              .writeHead(redirect.statusCode === 301 ? 301 : 308, { location: redirect.to })
              .end();
            return;
          }
          await fetch(`${apiBase}/public/blog/not-found`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: pathname, referer: request.headers.referer }),
          }).catch(() => {});
          response.writeHead(404).end("Not found");
          return;
        }
      }
      const blogMatch = pathname.match(/^(\/ar)?\/blog\/([^/]+)$/);
      let article, articlePayload, articleSlug, articleLanguage;
      if (blogMatch) {
        articleLanguage = blogMatch[1] ? "ar" : "en";
        articleSlug = blogMatch[2];
        articlePayload = await api(
          `/public/blog/articles/${encodeURIComponent(articleSlug)}?language=${articleLanguage}`,
        );
        if (articlePayload?.redirect?.to) {
          response
            .writeHead(articlePayload.redirect.statusCode === 301 ? 301 : 308, {
              location: articlePayload.redirect.to,
            })
            .end();
          return;
        }
        article = articlePayload?.article;
        if (!article) {
          await fetch(`${apiBase}/public/blog/not-found`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: pathname, referer: request.headers.referer }),
          }).catch(() => {});
          response.writeHead(404).end("Not found");
          return;
        }
      }
      const guideMatch=pathname.match(/^(\/ar)?\/guides\/([^/]+)$/);
      let guide;
      if(guideMatch){
        const language=guideMatch[1]?"ar":"en";
        guide=await api(`/public/guides/${encodeURIComponent(guideMatch[2])}?language=${language}`);
        if(guide?.redirect?.to){response.writeHead(guide.redirect.statusCode===301?301:308,{location:guide.redirect.to}).end();return;}
        if(!guide){response.writeHead(404).end("Not found");return;}
      }
      const helpHomeRequest = /^(\/ar)?\/resources$/.exec(pathname);
      const helpHomePayload = helpHomeRequest
        ? await api(`/public/website/help?locale=${helpHomeRequest[1] ? "ar" : "en"}`)
        : undefined;
      const helpArticleRequest = helpArticleRequestForPath(pathname);
      let helpArticlePayload;
      if (helpArticleRequest) {
        helpArticlePayload = await api(helpArticleRequest.apiPath);
        if (!helpArticlePayload?.article) {
          response.writeHead(404).end("Not found");
          return;
        }
      }
      let file = await fileResponse(pathname);
      const clientRoute = Boolean(
        article || guide || landing || helpArticlePayload || /^(\/ar)?\/send-a-package\/quote(\/|$)/.test(pathname),
      );
      if (!file && clientRoute) file = await fileResponse("/");
      if (!file) {
        response.writeHead(404).end("Not found");
        return;
      }
      let body = file.body;
      if (article && file.type.startsWith("text/html")) {
        const rendered = injectRenderedRoot(
          body.toString(),
          renderArticleShell(article, articlePayload?.related),
        );
        body = Buffer.from(injectArticleMetadata(rendered, article, pathname));
      } else if(guide && file.type.startsWith("text/html")) {
        const normalized={...guide,excerpt:guide.summary,featured_image_public_url:guide.featuredImagePublicUrl,featured_image_alt:guide.featuredImageAlt,robots_index:guide.robotsIndex,robots_follow:guide.robotsFollow,social_title:guide.socialTitle,social_description:guide.socialDescription,social_image_url:guide.socialImageUrl};
        body=Buffer.from(injectArticleMetadata(injectRenderedRoot(body.toString(),renderGuideShell(guide)),normalized,pathname).replace('property="og:type" content="article"','property="og:type" content="website"'));
      } else if (landing && file.type.startsWith("text/html"))
        body = Buffer.from(injectLandingMetadata(body.toString(), landing));
      else if (helpHomePayload && file.type.startsWith("text/html"))
        body = Buffer.from(
          injectRenderedRoot(body.toString(), renderHelpHomeShell(helpHomePayload)),
        );
      else if (helpArticlePayload?.article && file.type.startsWith("text/html")) {
        const rendered = injectRenderedRoot(
          body.toString(),
          renderHelpArticleShell(helpArticlePayload.article, helpArticlePayload.related),
        );
        body = Buffer.from(
          injectHelpArticleMetadata(rendered, helpArticlePayload.article, pathname),
        );
      }
      else if (file.type.startsWith("text/html"))
        body = Buffer.from(injectStaticPageMetadata(body.toString(), pathname));
      if (noindex && file.type.startsWith("text/html"))
        body = Buffer.from(injectRobotsDirective(body.toString(), noindex));
      send(
        response,
        200,
        {
          "content-type": file.type,
          "cache-control": cacheControlFor(pathname, file.type),
          "x-content-type-options": "nosniff",
        },
        body,
        request.headers["accept-encoding"],
      );
    } catch {
      response.writeHead(502).end("Upstream unavailable");
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  createPublicServer().listen(Number(process.env.PORT ?? 4174));
