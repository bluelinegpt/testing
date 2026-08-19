const SITE_URL = "https://tawseelhub.com";
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
export function applyPageMetadata(
  title: string,
  description: string,
  path: string,
  options: { canonical?: string; image?: string; robots?: string; type?: "article" | "website" } = {},
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
  setMeta('meta[name="twitter:card"]', "name", "twitter:card", "summary_large_image");
  setMeta('meta[name="twitter:title"]', "name", "twitter:title", fullTitle);
  setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
  setMeta('meta[name="twitter:image"]', "name", "twitter:image", options.image || `${SITE_URL}/og.png`);
  if (options.robots) setMeta('meta[name="robots"]', "name", "robots", options.robots);
  setLink("canonical", canonical);
  setLink("alternate", `${SITE_URL}${path}`, "en");
  setLink("alternate", canonical, "x-default");
}
