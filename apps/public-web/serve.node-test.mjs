import test from "node:test";
import assert from "node:assert/strict";
import {
  cacheControlFor,
  blogLandingRequestForPath,
  encodedBody,
  helpArticleRequestForPath,
  injectArticleMetadata,
  injectHelpArticleMetadata,
  injectLandingMetadata,
  injectRobotsDirective,
  injectRenderedRoot,
  injectStaticPageMetadata,
  isOriginHost,
  isPrivateIndexingPath,
  normalizePath,
  renderArticleShell,
  renderHelpArticleShell,
  renderGuideShell,
  robotsHeader,
  sitemapStylesheet,
  structuredDataForPath,
} from "./serve.mjs";
test("normalizes public paths", () => {
  assert.equal(normalizePath("//blog/example///"), "/blog/example");
  assert.equal(normalizePath("/"), "/");
});
test("server-rendered SEO Guide shell exposes full public content without Blog breadcrumbs",()=>{
  const html=renderGuideShell({language:"en",title:"Delivery Management Software UAE",summary:"Long-form guide summary",content:[{type:"h2",text:"Operations"},{type:"paragraph",text:"Crawler-visible Guide content."}]});
  assert.match(html,/Delivery Management Software UAE/);
  assert.match(html,/Crawler-visible Guide content/);
  assert.doesNotMatch(html,/href="\/blog/);
});
test("recognizes Render origins", () => assert.equal(isOriginHost("site.onrender.com"), true));
test("non-production is noindex", () =>
  assert.equal(robotsHeader("tawseelhub.com"), "noindex, nofollow"));
test("private result and search routes are noindex in English and Arabic", () => {
  for (const path of ["/track", "/ar/track", "/send-a-package/quote/Q-1", "/ar/send-a-package/quote/Q-1"])
    assert.equal(isPrivateIndexingPath(path), true, path);
  assert.equal(isPrivateIndexingPath("/resources", new URLSearchParams("q=order")), true);
  assert.equal(isPrivateIndexingPath("/ar/resources", new URLSearchParams("q=order")), true);
  assert.equal(isPrivateIndexingPath("/ar/resources"), false);
  assert.match(
    injectRobotsDirective('<head><meta name="robots" content="index,follow" /></head>', "noindex, follow"),
    /content="noindex, follow"/,
  );
});
test("immutable bundles and compressible responses use production-safe delivery", () => {
  assert.equal(
    cacheControlFor("/assets/index-abc.js", "text/javascript"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    cacheControlFor("/blog/article", "text/html"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  const compressed = encodedBody("x".repeat(5000), "text/html; charset=utf-8", "br, gzip");
  assert.equal(compressed.encoding, "br");
  assert.ok(compressed.body.length < 5000);
});
test("sitemap stylesheet renders sitemap XML as a human-readable table", () => {
  assert.match(sitemapStylesheet, /xsl:stylesheet/);
  assert.match(
    sitemapStylesheet,
    /xmlns:sitemap="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/,
  );
  assert.match(sitemapStylesheet, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.match(sitemapStylesheet, /sitemap:urlset\/sitemap:url/);
});
test("static homepage HTML includes parseable public page structured data", () => {
  const html = injectStaticPageMetadata(
    "<html><head><title>Tawseelhub</title></head><body></body></html>",
    "/",
  );
  assert.match(html, /data-static-schema="true"/);
  assert.match(html, /SoftwareApplication/);
  assert.match(html, /FAQPage/);
  const json = html.match(
    /<script type="application\/ld\+json" data-static-schema="true">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  const parsed = JSON.parse(json);
  assert.equal(parsed["@context"], "https://schema.org");
  assert.ok(parsed["@graph"].some((item) => item["@type"] === "SoftwareApplication"));
});
test("request-demo structured data points to the request-demo page", () => {
  const graph = structuredDataForPath("/request-demo");
  assert.ok(graph);
  const serialized = JSON.stringify(graph);
  assert.match(serialized, /\/request-demo#demo-request/);
  assert.doesNotMatch(serialized, /\/integrations#service/);
  assert.doesNotMatch(serialized, /Commerce Integrations/);
});
test("FAQ route structured data is only emitted for the real English FAQ route", () => {
  const english = injectStaticPageMetadata("<html><head></head><body></body></html>", "/faq");
  assert.match(english, /FAQPage/);
  assert.equal(structuredDataForPath("/ar/faq"), undefined);
});
test("Arabic help article paths request Arabic help content before falling back to the app shell", () => {
  assert.deepEqual(helpArticleRequestForPath("/ar/resources/what-is-tawseelhub"), {
    slug: "what-is-tawseelhub",
    locale: "ar",
    apiPath: "/public/website/help/articles/what-is-tawseelhub?locale=ar",
  });
  assert.deepEqual(helpArticleRequestForPath("/resources/what-is-tawseelhub"), {
    slug: "what-is-tawseelhub",
    locale: "en",
    apiPath: "/public/website/help/articles/what-is-tawseelhub?locale=en",
  });
  assert.equal(helpArticleRequestForPath("/ar/resources"), undefined);
});
test("blog landing paths call the correct plural public API routes", () => {
  assert.deepEqual(blogLandingRequestForPath("/blog/category/delivery-operations"), {
    kind: "category",
    slug: "delivery-operations",
    language: "en",
    apiPath: "/public/blog/categories/delivery-operations?language=en",
  });
  assert.deepEqual(blogLandingRequestForPath("/ar/blog/category/delivery-operations"), {
    kind: "category",
    slug: "delivery-operations",
    language: "ar",
    apiPath: "/public/blog/categories/delivery-operations?language=ar",
  });
  assert.equal(blogLandingRequestForPath("/blog"), undefined);
});
test("initial article HTML contains safe structured and social metadata", () => {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [{ "@type": "BlogPosting", headline: "Unsafe </script><script>alert(1)</script>" }],
  };
  const html = injectArticleMetadata(
    '<html><head><title>Old</title><meta name="description" content="Old" /></head></html>',
    {
      language: "en",
      title: 'Title "quoted"',
      excerpt: "Description",
      robots_index: true,
      robots_follow: true,
      seo: {
        canonical: "https://tawseelhub.com/blog/safe",
        title: "Social",
        description: "Share",
        image: "https://tawseelhub.com/image.jpg",
        imageAlt: 'Alt "text"',
        imageWidth: 1200,
        imageHeight: 630,
        graph,
      },
    },
    "/blog/safe",
  );
  assert.match(html, /property="og:url" content="https:\/\/tawseelhub.com\/blog\/safe"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /"@type":"BlogPosting"/);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script>/);
});
test("article HTML source can carry the rendered body for crawlers", () => {
  const html =
    '<html><head></head><body><div id="root"><main><section><h1>Old shell</h1></section></main></div><script type="module" src="/assets/index.js"></script></body></html>';
  const rendered =
    "<article><h1>Delivery Management Software UAE</h1><p>UAE&#x27;s delivery landscape has changed beyond recognition.</p></article>";
  const result = injectRenderedRoot(html, rendered);
  assert.match(result, /Delivery Management Software UAE/);
  assert.match(result, /UAE&#x27;s delivery landscape/);
  assert.doesNotMatch(result, /Old shell/);
  assert.match(result, /<script type="module" src="\/assets\/index.js">/);
});
test("article root replacement removes nested prerendered homepage content when scripts are in head", () => {
  const html =
    '<html><head><script type="module" src="/assets/index.js"></script></head><body><div id="root"><main><section><h1>Built for Delivery Businesses in the UAE</h1></section></main></div></body></html>';
  const result = injectRenderedRoot(html, "<article>Real article body</article>");
  assert.match(result, /Real article body/);
  assert.doesNotMatch(result, /Built for Delivery Businesses/);
  assert.match(result, /<script type="module" src="\/assets\/index.js">/);
});
test("server-rendered article shell includes the real blog body text", () => {
  const shell = renderArticleShell({
    language: "en",
    title: "Delivery Management Software UAE",
    excerpt: "A practical guide.",
    category: "Delivery Operations",
    category_slug: "delivery-operations",
    content: [
      { type: "p", text: "UAE's delivery landscape has changed beyond recognition." },
      { type: "h2", text: "Why it matters" },
      { type: "bullet_list", items: ["COD control", "Driver visibility"] },
    ],
  });
  assert.match(shell, /<article class="article-page"/);
  assert.match(shell, /UAE's delivery landscape/);
  assert.match(shell, /Driver visibility/);
});
test("initial Arabic article HTML is RTL and contains reciprocal language metadata", () => {
  const html = injectArticleMetadata(
    '<html lang="en"><head><title>Old</title><meta name="description" content="Old" /></head></html>',
    {
      language: "ar",
      title: "عنوان عربي",
      excerpt: "وصف عربي",
      robots_index: true,
      robots_follow: true,
      seo: {
        canonical: "https://tawseelhub.com/ar/blog/مقال",
        alternates: [
          { language: "ar", url: "https://tawseelhub.com/ar/blog/مقال" },
          { language: "en", url: "https://tawseelhub.com/blog/article" },
        ],
        xDefault: "https://tawseelhub.com/blog/article",
        alternateLocale: "en_AE",
      },
    },
    "/ar/blog/مقال",
  );
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /hreflang="ar" href="https:\/\/tawseelhub.com\/ar\/blog\/مقال"/);
  assert.match(html, /hreflang="en" href="https:\/\/tawseelhub.com\/blog\/article"/);
  assert.match(html, /property="og:locale" content="ar_AE"/);
});
test("initial taxonomy HTML contains canonical, schema, noindex policy and RSS discovery", () => {
  const html = injectLandingMetadata(
    '<html lang="en"><head><title>Old</title><meta name="description" content="Old" /><link rel="canonical" href="https://tawseelhub.com/blog" /><link rel="alternate" hreflang="en" href="https://tawseelhub.com/blog" /></head></html>',
    {
      name: "COD & Finance",
      language: "en",
      robots_index: false,
      robots_follow: true,
      seo: {
        title: "COD guides",
        description: "Curated COD guidance",
        canonical: "https://tawseelhub.com/blog/tag/cod",
        alternates: [{ language: "en", url: "https://tawseelhub.com/blog/tag/cod" }],
        graph: { "@context": "https://schema.org", "@type": "CollectionPage" },
      },
    },
  );
  assert.match(html, /name="robots" content="noindex,follow,max-image-preview:large"/);
  assert.match(html, /rel="canonical" href="https:\/\/tawseelhub.com\/blog\/tag\/cod"/);
  assert.match(html, /type="application\/rss\+xml"/);
  assert.match(html, /CollectionPage/);
  assert.equal((html.match(/hreflang="en"/g) ?? []).length, 1);
});
test("runtime Help articles keep their own canonical and crawler-visible content", () => {
  const article = {
    locale: "en",
    title: "Create an order",
    summary: "How to create an order.",
    body: [{ type: "paragraph", text: "Open Orders and select New Order." }],
    canonical_path: "/resources/create-an-order",
    robots_index: true,
    robots_follow: true,
  };
  const shell = renderHelpArticleShell(article);
  assert.match(shell, /Open Orders and select New Order/);
  const html = injectHelpArticleMetadata(
    '<html lang="en"><head><title>Home</title><meta name="description" content="Home" /><link rel="canonical" href="https://tawseelhub.com/" /></head><body></body></html>',
    article,
    "/resources/create-an-order",
  );
  assert.match(html, /rel="canonical" href="https:\/\/tawseelhub.com\/resources\/create-an-order"/);
  assert.match(html, /name="robots" content="index,follow,max-image-preview:large"/);
  assert.doesNotMatch(html, /rel="canonical" href="https:\/\/tawseelhub.com\/"/);
});
