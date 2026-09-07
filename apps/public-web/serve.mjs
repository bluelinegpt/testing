import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const directory = join(fileURLToPath(new URL(".", import.meta.url)), "dist");
const apiBase = (process.env.PUBLIC_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1").replace(/\/$/, "");
const canonicalOrigin = "https://tawseelhub.com";
const production = process.env.PUBLIC_SEO_ENVIRONMENT === "production";
export const normalizePath = (pathname) => pathname === "/" ? "/" : `/${pathname.replace(/^\/+|\/+$/g, "")}`;
export const isOriginHost = (host) => /\.onrender\.com(?::\d+)?$/i.test(host);
export const robotsHeader = (host) => production && !isOriginHost(host) ? undefined : "noindex, nofollow";
export const cacheControlFor = (pathname, type) => pathname.startsWith("/assets/")
  ? "public, max-age=31536000, immutable"
  : type.startsWith("text/html") ? "public, max-age=60, stale-while-revalidate=300" : "public, max-age=86400";
export function encodedBody(body, type, acceptEncoding = "") {
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (source.length < 1024 || !/^(text\/|application\/(?:javascript|json|xml|rss\+xml))/.test(type)) return { body: source };
  if (/\bbr\b/.test(acceptEncoding)) return { body: brotliCompressSync(source), encoding: "br" };
  if (/\bgzip\b/.test(acceptEncoding)) return { body: gzipSync(source), encoding: "gzip" };
  return { body: source };
}
function send(response, status, headers, body, acceptEncoding = "") {
  const encoded = encodedBody(body, headers["content-type"] ?? "", acceptEncoding);
  response.writeHead(status, { ...headers, ...(encoded.encoding ? { "content-encoding": encoded.encoding, vary: "Accept-Encoding" } : {}) });
  response.end(encoded.body);
}
const types = { ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".xml":"application/xml; charset=utf-8", ".txt":"text/plain; charset=utf-8", ".html":"text/html; charset=utf-8" };
const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const safeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const assetUrl = (value) => !value ? "" : /^https:\/\//i.test(value) ? value : value.startsWith("/api/") ? `${apiBase.replace(/\/api\/v1$/, "")}${value}` : `${canonicalOrigin}${value.startsWith("/") ? value : `/${value}`}`;
async function api(path) { const response = await fetch(`${apiBase}${path}`, { headers: { accept: "application/json" } }); return response.ok ? response.json() : undefined; }
export function injectArticleMetadata(html, article, pathname) {
  const seo = article.seo ?? {};
  const canonical = seo.canonical || article.canonical_url || `${canonicalOrigin}${pathname}`;
  const title = seo.title || article.social_title || article.seo_title || article.title;
  const description = seo.description || article.social_description || article.meta_description || article.excerpt;
  const image = assetUrl(seo.image || article.social_image_url || article.featured_image_public_url);
  const robots = `${article.robots_index ? "index" : "noindex"},${article.robots_follow ? "follow" : "nofollow"},max-image-preview:large`;
  const imageMetadata = image ? `<meta property="og:image" content="${escape(image)}" />${seo.imageAlt ? `<meta property="og:image:alt" content="${escape(seo.imageAlt)}" /><meta name="twitter:image:alt" content="${escape(seo.imageAlt)}" />` : ""}${seo.imageWidth ? `<meta property="og:image:width" content="${seo.imageWidth}" />` : ""}${seo.imageHeight ? `<meta property="og:image:height" content="${seo.imageHeight}" />` : ""}<meta name="twitter:image" content="${escape(image)}" />` : "";
  const alternates=(seo.alternates??[{language:article.language==="ar"?"ar":"en",url:canonical}]).map((item)=>`<link rel="alternate" hreflang="${escape(item.language)}" href="${escape(item.url)}" />`).join("")+(seo.xDefault?`<link rel="alternate" hreflang="x-default" href="${escape(seo.xDefault)}" />`:"")+`<link rel="alternate" type="application/rss+xml" title="Tawseelhub Blog RSS" href="${article.language==="ar"?"/ar":""}/blog/rss.xml" />`;
  const metadata = `<meta name="robots" content="${escape(robots)}" /><link rel="canonical" href="${escape(canonical)}" />${alternates}<meta property="og:type" content="article" /><meta property="og:title" content="${escape(title)}" /><meta property="og:description" content="${escape(description)}" /><meta property="og:url" content="${escape(canonical)}" /><meta property="og:site_name" content="Tawseelhub" /><meta property="og:locale" content="${article.language === "ar" ? "ar_AE" : "en_AE"}" />${seo.alternateLocale?`<meta property="og:locale:alternate" content="${escape(seo.alternateLocale)}" />`:""}${imageMetadata}<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" /><meta name="twitter:title" content="${escape(title)}" /><meta name="twitter:description" content="${escape(description)}" />${seo.graph ? `<script type="application/ld+json" data-seo-schema="true">${safeJson(seo.graph)}</script>` : ""}`;
  const cleaned = html
    .replace(/<link rel="canonical"[^>]*>/g, "")
    .replace(/<link rel="alternate"[^>]*>/g, "")
    .replace(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g, "")
    .replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, "");
  return cleaned.replace(/<html lang="[^"]+"(?: dir="[^"]+")?>/,article.language==="ar"?'<html lang="ar" dir="rtl">':'<html lang="en" dir="ltr">').replace(/<title>.*?<\/title>/, `<title>${escape(title)} | Tawseelhub</title>`).replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${escape(description)}" />${metadata}`);
}
export function injectLandingMetadata(html, landing) {
  const seo=landing.seo??{},title=seo.title??landing.name??landing.title??landing.display_name,description=seo.description??landing.description??landing.short_bio??"",canonical=seo.canonical;
  const alternates=(seo.alternates??[]).map(item=>`<link rel="alternate" hreflang="${escape(item.language)}" href="${escape(item.url)}" />`).join("")+(seo.xDefault?`<link rel="alternate" hreflang="x-default" href="${escape(seo.xDefault)}" />`:"");
  const metadata=`<meta name="robots" content="${landing.robots_index?"index":"noindex"},${landing.robots_follow===false?"nofollow":"follow"},max-image-preview:large" /><link rel="canonical" href="${escape(canonical)}" />${alternates}<link rel="alternate" type="application/rss+xml" title="Tawseelhub Blog RSS" href="${landing.language==="ar"?"/ar":""}/blog/rss.xml" /><meta property="og:type" content="website" /><meta property="og:title" content="${escape(title)}" /><meta property="og:description" content="${escape(description)}" /><meta property="og:url" content="${escape(canonical)}" />${seo.graph?`<script type="application/ld+json" data-seo-schema="true">${safeJson(seo.graph)}</script>`:""}`;
  return html.replace(/<title>.*?<\/title>/,`<title>${escape(title)} | Tawseelhub</title>`).replace(/<meta name="description" content=".*?" \/>/,`<meta name="description" content="${escape(description)}" />${metadata}`);
}
async function fileResponse(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = normalize(join(directory, relative));
  if (!candidate.startsWith(directory)) return undefined;
  try { const info = await stat(candidate); const file = info.isDirectory() ? join(candidate, "index.html") : candidate; return { body: await readFile(file), type: types[extname(file)] ?? "application/octet-stream" }; } catch { return undefined; }
}
export function injectRenderedRoot(html, rendered) {
  const body = String(rendered ?? "");
  const rootStart = html.indexOf('<div id="root"');
  if (rootStart < 0) return html;
  const rootOpenEnd = html.indexOf(">", rootStart);
  if (rootOpenEnd < 0) return html;
  const scriptStart = html.indexOf('<script type="module"', rootOpenEnd);
  if (scriptStart >= 0) return `${html.slice(0, rootStart)}<div id="root">${body}</div>\n    ${html.slice(scriptStart)}`;
  const bodyEnd = html.indexOf("</body>", rootOpenEnd);
  if (bodyEnd >= 0) return `${html.slice(0, rootStart)}<div id="root">${body}</div>${html.slice(bodyEnd)}`;
  return html.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${body}</div>`);
}
function articleBlockHtml(block) {
  const text = block?.text ?? "";
  if (block?.type === "html") return text;
  if (block?.type === "h2") return `<h2>${escape(text)}</h2>`;
  if (block?.type === "h3") return `<h3>${escape(text)}</h3>`;
  if (block?.type === "blockquote") return `<blockquote>${escape(text)}</blockquote>`;
  if (block?.type === "bullet_list") return `<ul>${(block.items ?? []).map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`;
  if (block?.type === "numbered_list") return `<ol>${(block.items ?? []).map((item) => `<li>${escape(item)}</li>`).join("")}</ol>`;
  return `<p>${escape(text)}</p>`;
}
export function renderArticleShell(article, related = []) {
  const language = article.language === "ar" ? "ar" : "en";
  const dir = language === "ar" ? "rtl" : "ltr";
  const categorySlug = article.category_slug ?? "";
  const image = assetUrl(article.featured_image_public_url);
  const tags = (article.tags ?? []).map((tag) => `<a href="${language === "ar" ? "/ar" : ""}/blog/tag/${escape(tag.slug)}">#${escape(tag.name)}</a>`).join("");
  const blocks = (article.content ?? []).map(articleBlockHtml).join("");
  const relatedHtml = related.length ? `<section class="related-articles"><h2>${language === "ar" ? "مقالات ذات صلة" : "Related articles"}</h2>${related.map((item) => `<article><h3><a href="${language === "ar" ? "/ar" : ""}/blog/${escape(item.slug)}">${escape(item.title)}</a></h3><p>${escape(item.excerpt ?? "")}</p></article>`).join("")}</section>` : "";
  return `<article class="article-page" dir="${dir}" lang="${language}"><nav aria-label="Breadcrumb"><a href="${language === "ar" ? "/ar" : "/"}">${language === "ar" ? "الرئيسية" : "Home"}</a> / <a href="${language === "ar" ? "/ar" : ""}/blog">${language === "ar" ? "المدونة" : "Blog"}</a> / <a href="${language === "ar" ? "/ar" : ""}/blog/category/${escape(categorySlug)}">${escape(article.category ?? "")}</a></nav><header><span>${escape(article.category ?? "")}</span><h1>${escape(article.title)}</h1><p>${escape(article.excerpt)}</p></header>${tags ? `<nav class="blog-categories" aria-label="Article tags">${tags}</nav>` : ""}${image ? `<img class="article-image" src="${escape(image)}" alt="${escape(article.featured_image_alt ?? "")}" width="${article.featured_image_width ?? 1200}" height="${article.featured_image_height ?? 675}" loading="eager" decoding="async" fetchpriority="high" />` : ""}<div class="article-layout"><div class="article-body">${blocks}</div><aside><h2>${language === "ar" ? "استكشف Tawseelhub" : "Explore Tawseelhub"}</h2><a href="${language === "ar" ? "/ar" : ""}/delivery-companies">${language === "ar" ? "منصة شركة التوصيل" : "Delivery Company platform"}</a><a href="${language === "ar" ? "/ar" : ""}/traders">${language === "ar" ? "حلول للتجار" : "Solutions for Traders"}</a><a href="${language === "ar" ? "/ar" : ""}/send-a-package">${language === "ar" ? "أرسل شحنة" : "Send a Package"}</a></aside></div>${relatedHtml}</article>`;
}
export function createPublicServer() {
  return createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "localhost";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const pathname = normalizePath(url.pathname);
      if (pathname === "/healthz") { response.writeHead(200, { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }).end('{"status":"ok"}'); return; }
      if (production && /^www\.tawseelhub\.com(?::\d+)?$/i.test(host)) { response.writeHead(308, { location: `${canonicalOrigin}${pathname}${url.search}` }).end(); return; }
      if (url.pathname !== pathname && url.pathname !== "/") { response.writeHead(308, { location: `${pathname}${url.search}` }).end(); return; }
      if (url.searchParams.has("lang")) { url.searchParams.delete("lang"); const search=url.searchParams.toString(); response.writeHead(308,{location:`${pathname}${search?`?${search}`:""}`}).end(); return; }
      const privatePath = /^(\/track|\/send-a-package\/quote)(\/|$)/.test(pathname) || (pathname === "/resources" && url.searchParams.has("q"));
      const noindex = privatePath ? "noindex, follow" : robotsHeader(host); if (noindex) response.setHeader("X-Robots-Tag", noindex);
      if (pathname.startsWith("/api/")) { const upstream = await fetch(`${apiBase.replace(/\/api\/v1$/, "")}${pathname}${url.search}`, { method:request.method, headers:{ accept:request.headers.accept ?? "*/*" } }); response.writeHead(upstream.status, { "content-type":upstream.headers.get("content-type") ?? "application/octet-stream", "cache-control":upstream.headers.get("cache-control") ?? "public, max-age=60" }); response.end(Buffer.from(await upstream.arrayBuffer())); return; }
      if (pathname === "/sitemap.xml") { const upstream = await fetch(`${apiBase}/public/website/sitemap.xml`); send(response, upstream.status, { "content-type":"application/xml; charset=utf-8", "cache-control":"public, max-age=60, stale-while-revalidate=300" }, Buffer.from(await upstream.arrayBuffer()), request.headers["accept-encoding"]); return; }
      if (/^(\/ar)?\/blog\/rss\.xml$/.test(pathname)) { const upstream=await fetch(`${apiBase}/public/blog/rss.xml?language=${pathname.startsWith("/ar/")?"ar":"en"}`);send(response,upstream.status,{"content-type":"application/rss+xml; charset=utf-8","cache-control":"public, max-age=300, stale-while-revalidate=900"},Buffer.from(await upstream.arrayBuffer()),request.headers["accept-encoding"]);return; }
      if (pathname === "/robots.txt" && isOriginHost(host)) { response.writeHead(200, { "content-type":"text/plain; charset=utf-8" }).end("User-agent: *\nDisallow: /\n"); return; }
      const landingMatch=pathname.match(/^(\/ar)?\/blog\/(category|tag|topic|author)\/([^/]+)$/);
      let landing;
      if(landingMatch){const language=landingMatch[1]?"ar":"en";landing=await api(`/public/blog/${landingMatch[2]}s/${encodeURIComponent(landingMatch[3])}?language=${language}`);if(!landing){const redirect=await api(`/public/blog/redirect?path=${encodeURIComponent(pathname)}`);if(redirect?.to){response.writeHead(redirect.statusCode===301?301:308,{location:redirect.to}).end();return;}await fetch(`${apiBase}/public/blog/not-found`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:pathname,referer:request.headers.referer})}).catch(()=>{});response.writeHead(404).end("Not found");return;}}
      const blogMatch = pathname.match(/^(\/ar)?\/blog\/([^/]+)$/);
      let article, articlePayload, articleSlug, articleLanguage;
       if (blogMatch) { articleLanguage=blogMatch[1]?"ar":"en"; articleSlug=blogMatch[2]; articlePayload = await api(`/public/blog/articles/${encodeURIComponent(articleSlug)}?language=${articleLanguage}`); if (articlePayload?.redirect?.to) { response.writeHead(articlePayload.redirect.statusCode === 301 ? 301 : 308, { location: articlePayload.redirect.to }).end(); return; } article = articlePayload?.article; if (!article) { await fetch(`${apiBase}/public/blog/not-found`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:pathname,referer:request.headers.referer})}).catch(()=>{});response.writeHead(404).end("Not found"); return; } }
      const helpMatch = pathname.match(/^\/resources\/([^/]+)$/);
      if (helpMatch) { const payload = await api(`/public/website/help/articles/${encodeURIComponent(helpMatch[1])}?locale=en`); if (!payload?.article) { response.writeHead(404).end("Not found"); return; } }
      let file = await fileResponse(pathname);
       const clientRoute = Boolean(article || landing || helpMatch || /^\/send-a-package\/quote(\/|$)/.test(pathname));
      if (!file && clientRoute) file = await fileResponse("/");
      if (!file) { response.writeHead(404).end("Not found"); return; }
       let body = file.body; if (article && file.type.startsWith("text/html")) { const rendered = injectRenderedRoot(body.toString(), renderArticleShell(article, articlePayload?.related)); body = Buffer.from(injectArticleMetadata(rendered, article, pathname)); } else if(landing&&file.type.startsWith("text/html"))body=Buffer.from(injectLandingMetadata(body.toString(),landing));
      send(response, 200, { "content-type":file.type, "cache-control":cacheControlFor(pathname,file.type), "x-content-type-options":"nosniff" }, body, request.headers["accept-encoding"]);
    } catch { response.writeHead(502).end("Upstream unavailable"); }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) createPublicServer().listen(Number(process.env.PORT ?? 4174));
