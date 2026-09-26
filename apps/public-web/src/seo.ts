const SITE_URL = "https://tawseelhub.com";
export function publicRobotsDirective(index = true, follow = true): string {
  const host = typeof window === "undefined" ? "tawseelhub.com" : window.location.hostname;
  const protectedEnvironment = host === "localhost" || host === "127.0.0.1" || host.endsWith(".onrender.com");
  if (protectedEnvironment) return "noindex,nofollow";
  return `${index ? "index" : "noindex"},${follow ? "follow" : "nofollow"}${index ? ",max-image-preview:large" : ""}`;
}
function setMeta(selector: string, attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.content = content;
}
function setLink(rel: string, href: string, hreflang?: string) {
  const selector = hreflang
    ? `link[rel="${rel}"][hreflang="${hreflang}"]`
    : `link[rel="${rel}"]:not([hreflang])`;
  let element = document.head.querySelector<HTMLLinkElement>(selector);
  if (!element) {
    element = document.createElement("link");
    element.rel = rel;
    if (hreflang) element.hreflang = hreflang;
    document.head.append(element);
  }
  element.href = href;
}
export type SeoAlternate = { language: "en" | "ar"; url: string };
export function applyPageMetadata(
  title: string,
  description: string,
  path: string,
  options: { canonical?: string; image?: string; imageAlt?: string; imageWidth?: number; imageHeight?: number; robots?: string; type?: "article" | "website"; locale?: string; alternateLocale?: string | null; alternates?: SeoAlternate[]; xDefault?: string | null; schema?: object } = {},
) {
  const fullTitle = /tawseelhub/i.test(title) ? title : `${title} | Tawseelhub`;
  const canonical = options.canonical || `${SITE_URL}${path}`;
  document.title = fullTitle;
  setMeta('meta[name="description"]', "name", "description", description);
  setMeta('meta[property="og:title"]', "property", "og:title", fullTitle);
  setMeta('meta[property="og:description"]', "property", "og:description", description);
  setMeta('meta[property="og:type"]', "property", "og:type", options.type ?? "website");
  setMeta('meta[property="og:url"]', "property", "og:url", canonical);
  setMeta('meta[property="og:image"]', "property", "og:image", options.image || `${SITE_URL}/og.png`);
  setMeta('meta[property="og:site_name"]', "property", "og:site_name", "Tawseelhub");
  setMeta('meta[property="og:locale"]', "property", "og:locale", options.locale === "ar" ? "ar_AE" : "en_AE");
  document.head.querySelector('meta[property="og:locale:alternate"]')?.remove();
  if (options.alternateLocale) setMeta('meta[property="og:locale:alternate"]', "property", "og:locale:alternate", options.alternateLocale);
  if (options.imageAlt) setMeta('meta[property="og:image:alt"]', "property", "og:image:alt", options.imageAlt);
  if (options.imageWidth) setMeta('meta[property="og:image:width"]', "property", "og:image:width", String(options.imageWidth));
  if (options.imageHeight) setMeta('meta[property="og:image:height"]', "property", "og:image:height", String(options.imageHeight));
  setMeta('meta[name="twitter:card"]', "name", "twitter:card", "summary_large_image");
  setMeta('meta[name="twitter:title"]', "name", "twitter:title", fullTitle);
  setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
  setMeta('meta[name="twitter:image"]', "name", "twitter:image", options.image || `${SITE_URL}/og.png`);
  if (options.imageAlt) setMeta('meta[name="twitter:image:alt"]', "name", "twitter:image:alt", options.imageAlt);
  setMeta('meta[name="robots"]', "name", "robots", options.robots ?? publicRobotsDirective());
  setLink("canonical", canonical);
  document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((link) => link.remove());
  const language = options.locale === "ar" ? "ar" : "en";
  const alternates = options.alternates ?? [{ language, url: canonical }];
  for (const alternate of alternates) setLink("alternate", alternate.url, alternate.language);
  if (options.xDefault !== null) setLink("alternate", options.xDefault ?? alternates.find((item) => item.language === "en")?.url ?? canonical, "x-default");
  document.head.querySelector('script[data-seo-schema="true"]')?.remove();
  if (options.schema) {
    const script = document.createElement("script"); script.type = "application/ld+json"; script.dataset.seoSchema = "true";
    script.text = JSON.stringify(options.schema).replaceAll("<", "\\u003c"); document.head.append(script);
  }
}
