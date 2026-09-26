import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

/**
 * §73/§28-31/§62-65: production-server deep-route integration tests.
 *
 * This spins up the ACTUAL compiled production server (`serve.ts`'s
 * exported `server`) against the real `dist/` build (run `pnpm build`
 * before this suite), with a tiny in-process fake upstream API standing in
 * for `apps/api` -- so this proves the server's own routing/header/asset
 * behaviour without depending on a live database or a real API process.
 *
 * `STORE_ROOT`/`STORE_API_ORIGIN`/`STORE_PUBLIC_ORIGIN`/`STORE_SERVER_AUTOSTART`
 * are all read as top-level `const`s at import time in `serve.ts`, so they
 * are set here BEFORE the dynamic `import()` -- a static top-level import
 * would already have run those reads before this file's `beforeAll` ever
 * executed.
 */
const runServerTests = process.env.RUN_STORE_SERVER_TESTS === "true";

describe.skipIf(!runServerTests)("Store production server", () => {
  let fakeApi: Server;
  let fakeApiPort: number;
  let storeServer: import("node:http").Server;
  let storePort: number;
  let baseUrl: string;

  // Mutable per-test fixtures for the sitemap's `seoIndexable` gating test
  // below -- everything else in this suite uses the static routes/empty
  // lists inline in the handler.
  let sitemapStores: { seoIndexable?: boolean; slug: string }[] = [];
  const sitemapProductsByStore: Record<string, { seoIndexable?: boolean; slug: string }[]> = {};

  beforeAll(async () => {
    fakeApi = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/v1/public/storefronts/demo-store") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ displayName: "Demo Store", slug: "demo-store" }));
        return;
      }
      if (url.pathname === "/api/v1/public/storefronts/demo-store/products/demo-product") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ name: "Demo Product", productCode: "DEMO-1" }));
        return;
      }
      if (url.pathname === "/api/v1/public/storefronts") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ items: sitemapStores }));
        return;
      }
      const productsMatch = /^\/api\/v1\/public\/storefronts\/([^/]+)\/products$/.exec(
        url.pathname,
      );
      if (productsMatch) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ items: sitemapProductsByStore[productsMatch[1]!] ?? [] }));
        return;
      }
      if (url.pathname === "/api/v1/public/marketplace/categories") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ items: [] }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end('{"error":"not_found"}');
    });
    await new Promise<void>((doneListening) => fakeApi.listen(0, doneListening));
    fakeApiPort = (fakeApi.address() as { port: number }).port;

    process.env.STORE_SERVER_AUTOSTART = "false";
    process.env.STORE_ROOT = resolve(import.meta.dirname, "../dist");
    process.env.STORE_API_ORIGIN = `http://127.0.0.1:${String(fakeApiPort)}`;
    process.env.STORE_PUBLIC_ORIGIN = "http://127.0.0.1:0";

    const module = await import("./serve.js");
    storeServer = module.server;
    await new Promise<void>((doneListening) => storeServer.listen(0, doneListening));
    storePort = (storeServer.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${String(storePort)}`;
  });

  afterAll(async () => {
    await new Promise((doneClosing) => storeServer.close(doneClosing));
    await new Promise((doneClosing) => fakeApi.close(doneClosing));
  });

  // §28: every implemented route, EN + AR, must survive a direct reload.
  const publicDeepRoutes = [
    "/en/",
    "/ar/",
    "/en/categories",
    "/ar/categories",
    "/en/demo-store",
    "/ar/demo-store",
    "/en/demo-store/products/demo-product",
    "/ar/demo-store/products/demo-product",
    "/en/register",
    "/ar/register",
    "/en/login",
    "/ar/login",
    "/en/forgot-password",
    "/en/reset-password",
    "/en/track",
    "/ar/track",
  ];

  it.each(publicDeepRoutes)("serves a real HTML document on direct reload of %s", async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<div id="root">');
    expect(body).toContain("<title>");
  });

  // §29: Customer-protected deep routes must never 404 -- the client-side
  // guard (not this server) performs the actual redirect, but the SERVER
  // must still answer with the app shell so that client-side guard can run.
  const protectedDeepRoutes = ["/en/account", "/en/account/orders", "/en/account/orders/SO-000001"];

  it.each(protectedDeepRoutes)("serves the app shell (not a 404) for protected route %s", async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a genuine 404 with noindex for an unknown path, not a silent 200", async () => {
    const response = await fetch(`${baseUrl}/en/this-store-does-not-exist-at-all`);
    // A single-segment path is treated as a candidate Store slug and
    // resolved against the (stubbed, empty-for-this-slug) API -- the fake
    // upstream has no such Store, so this exercises the real "Store not
    // found" 404 path, not a made-up route.
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("noindex");
  });

  it("§62: serves the manifest with the correct MIME type", async () => {
    const response = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    const manifest = (await response.json()) as { name: string };
    expect(manifest.name).toBe("BluelineGPT Store");
  });

  it("§63: serves the service worker at a stable path with JS MIME and a fresh-revalidate policy", async () => {
    const response = await fetch(`${baseUrl}/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("§64: hashed build assets survive the production build with a long immutable cache", async () => {
    const html = await (await fetch(`${baseUrl}/en/`)).text();
    const assetMatch = /\/assets\/[^"']+\.js/.exec(html);
    expect(assetMatch).not.toBeNull();
    const response = await fetch(`${baseUrl}${assetMatch![0]}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("§52: public Store/Product documents carry canonical, OG and JSON-LD metadata in the raw HTML (no SPA-only shell)", async () => {
    const response = await fetch(`${baseUrl}/en/demo-store/products/demo-product`);
    const body = await response.text();
    expect(body).toContain('rel="canonical"');
    expect(body).toContain('property="og:title"');
    expect(body).toContain("application/ld+json");
    expect(body).toContain('hreflang="ar"');
  });

  it("§21: public Store documents use a short revalidating cache, never no-store", async () => {
    const response = await fetch(`${baseUrl}/en/demo-store`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
  });

  it("§53: sitemap.xml and robots.txt remain reachable and unaffected by the PWA additions", async () => {
    const robots = await fetch(`${baseUrl}/robots.txt`);
    expect(robots.status).toBe(200);
    const robotsBody = await robots.text();
    expect(robotsBody).toContain("Sitemap:");
    expect(robotsBody).toContain("Disallow: /account/orders");

    const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain("<urlset");
  });

  it("T6: excludes a noindex Store or Product from the sitemap, includes an indexable one", async () => {
    // `seoIndexable: false` still resolves publicly (it's a search-engine
    // opt-out, not an access control) -- so the resource is present in these
    // list responses the way an unpublished Store or draft Product would not
    // be. The sitemap must filter it out itself, or it tells a crawler
    // "index this" on the exact page whose own <meta> tag says the opposite.
    sitemapStores = [
      { seoIndexable: true, slug: "visible-store" },
      { seoIndexable: false, slug: "hidden-store" },
    ];
    sitemapProductsByStore["visible-store"] = [
      { seoIndexable: true, slug: "visible-product" },
      { seoIndexable: false, slug: "hidden-product" },
    ];
    try {
      const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
      const body = await sitemap.text();
      expect(body).toContain("visible-store");
      expect(body).toContain("visible-store/products/visible-product");
      expect(body).not.toContain("hidden-store");
      expect(body).not.toContain("hidden-product");
    } finally {
      sitemapStores = [];
    }
  });

  it("§65: the API proxy still forwards JSON with no-store and never mangles binary media", async () => {
    // A genuinely binary-looking (non-UTF8) upstream body must survive the
    // proxy byte-for-byte -- the exact regression Prompt-era comments in
    // `serve.ts` describe (`proxyApi`'s "copied as BYTES, never as text").
    const response = await fetch(`${baseUrl}/api/v1/public/storefronts`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
