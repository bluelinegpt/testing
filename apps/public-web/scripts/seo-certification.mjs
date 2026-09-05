const origin = new URL(process.argv[2] ?? "https://tawseelhub.com");
if (origin.protocol !== "https:" || origin.hostname !== "tawseelhub.com") throw new Error("Certification is limited to https://tawseelhub.com.");
const timeoutMs = 10_000;
const responseCache = new Map();
let requestCount = 0;
async function get(path, redirect = "follow") {
  const key = `${redirect}:${path}`;
  if (responseCache.has(key)) return responseCache.get(key);
  if (++requestCount > 750) throw new Error("Certification request budget exceeded.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, origin), { redirect, signal: controller.signal, headers: { "user-agent": "Tawseelhub-SEO-Certification/1.0" } });
    const body = await response.text();
    const result = { status: response.status, ok: response.ok, headers: response.headers, text: async () => body };
    responseCache.set(key, result);
    return result;
  }
  finally { clearTimeout(timeout); }
}
const sitemapResponse = await get("/sitemap.xml");
const sitemap = await sitemapResponse.text();
if (!sitemapResponse.ok || !/<urlset\b/.test(sitemap)) throw new Error(`Invalid sitemap: HTTP ${sitemapResponse.status}`);
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).filter(Boolean);
if (!urls.length || urls.length > 5000) throw new Error(`Unsafe sitemap URL count: ${urls.length}`);
const issues = [];
for (const value of urls.slice(0, 250)) {
  const url = new URL(value);
  if (url.origin !== origin.origin) { issues.push(`${value}: non-production origin`); continue; }
  const response = await get(url.pathname + url.search);
  const html = await response.text();
  if (response.status !== 200) issues.push(`${value}: HTTP ${response.status}`);
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1];
  if (!canonical || new URL(canonical, origin).origin !== origin.origin) issues.push(`${value}: missing/invalid canonical`);
  if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)) issues.push(`${value}: sitemap URL is noindex`);
  for (const match of html.matchAll(/<link[^>]+rel=["']alternate["'][^>]+hreflang=["'][^"']+["'][^>]+href=["']([^"']+)/gi)) {
    const alternate = new URL(match[1], origin);
    const alternateResponse = await get(alternate.pathname, "manual");
    if (alternate.origin !== origin.origin || alternateResponse.status !== 200) issues.push(`${value}: broken hreflang ${alternate.href} (${alternateResponse.status})`);
  }
  for (const match of html.matchAll(/(?:href|src)=["'](\/[^"'#?]*)/gi)) {
    if (/^\/api\//.test(match[1])) continue;
    const linked = await get(match[1], "manual");
    if (linked.status >= 400) issues.push(`${value}: broken internal resource ${match[1]} (${linked.status})`);
  }
}
for (const path of ["/robots.txt", "/blog/rss.xml", "/ar/blog/rss.xml"]) {
  const response = await get(path);
  if (!response.ok) issues.push(`${path}: HTTP ${response.status}`);
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), sitemapUrls: urls.length, crawled: Math.min(urls.length, 250), requests: requestCount, issues }, null, 2));
if (issues.length) throw new Error(`SEO certification failed with ${issues.length} issue(s).`);
