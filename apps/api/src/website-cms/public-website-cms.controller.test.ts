import { describe, expect, it, vi } from "vitest";
import { PublicWebsiteCmsController } from "./public-website-cms.controller.js";
import { renderLocalizedSitemap } from "./website-cms.service.js";

describe("public technical SEO endpoints", () => {
  it("renders English, Arabic and x-default sitemap alternates with localized lastmod", () => {
    const xml = renderLocalizedSitemap("https://tawseelhub.com", [
      {
        path: "/ar/blog/مقال",
        lastmod: "2026-09-05T00:00:00.000Z",
        alternates: [
          { locale: "en", path: "/blog/article" },
          { locale: "ar", path: "/ar/blog/مقال" },
        ],
        xDefault: "/blog/article",
      },
    ]);
    expect(xml).toContain('<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain("<loc>https://tawseelhub.com/ar/blog/مقال</loc>");
    expect(xml).toContain('hreflang="ar" href="https://tawseelhub.com/ar/blog/مقال"');
    expect(xml).toContain("<lastmod>2026-09-05T00:00:00.000Z</lastmod>");
  });
  it("serves the database-backed sitemap as XML", async () => {
    const xml =
      '<?xml version="1.0"?><urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://tawseelhub.com/ar/blog/مقال</loc><xhtml:link rel="alternate" hreflang="en" href="https://tawseelhub.com/blog/article" /></url></urlset>';
    const sitemapXml = vi.fn().mockResolvedValue(xml);
    const controller = new PublicWebsiteCmsController({ sitemapXml } as never);
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    await controller.sitemapXml({ status } as never);
    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith(xml);
  });
});
