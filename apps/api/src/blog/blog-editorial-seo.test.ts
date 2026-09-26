import { describe, expect, it, vi } from "vitest";
import { DummyDriver, Kysely, PostgresDialect } from "kysely";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { BlogService, publicArticleSeo } from "./blog.service.js";

function fixture(rows: Record<string, unknown>[] = []) {
  const statements: string[] = [];
  const driver = new DummyDriver();
  vi.spyOn(driver, "acquireConnection").mockResolvedValue({
    executeQuery: async (query: { sql: string }) => {
      statements.push(query.sql);
      return { rows };
    },
    async *streamQuery() { yield { rows: [] }; },
  } as never);
  const dialect = new PostgresDialect({ pool: {} as never });
  vi.spyOn(dialect, "createDriver").mockReturnValue(driver);
  return { service: new BlogService(new Kysely<DatabaseSchema>({ dialect })), statements };
}

describe("Blog editorial SEO", () => {
  it("links BlogPosting authors to the safe public Person entity", () => {
    const seo=publicArticleSeo({slug:"operations",language:"en",title:"Operations",excerpt:"Guide",category:"Delivery",category_slug:"delivery",author:"Haseeb",author_slug:"haseeb",published_at:"2026-09-05T00:00:00Z"});
    const posting=seo.graph["@graph"].find((item:any)=>item["@type"]==="BlogPosting");
    expect(posting!.author).toEqual(expect.objectContaining({name:"Haseeb",url:"https://tawseelhub.com/blog/author/haseeb","@id":"https://tawseelhub.com/blog/author/haseeb#person"}));
  });

  it("emits language-specific RSS with canonical public URLs", async () => {
    const {service,statements}=fixture([{slug:"إدارة-التوصيل",title:"إدارة التوصيل",excerpt:"ملخص",published_at:"2026-09-05T00:00:00Z",author:"فريق توصـيل هب",category:"العمليات"}]);
    const xml=await service.rss("ar");
    expect(xml).toContain("<language>ar</language>");
    expect(xml).toContain("https://tawseelhub.com/ar/blog/%D8%A5%D8%AF%D8%A7%D8%B1%D8%A9-%D8%A7%D9%84%D8%AA%D9%88%D8%B5%D9%8A%D9%84");
    expect(statements[0]).toContain("a.robots_index");
    expect(statements[0]).toContain("a.published_at<=now()");
  });

  it("builds a populated category landing query without exposing database IDs", async () => {
    const {service,statements}=fixture([{id:"private-id",name:"Delivery Operations",slug:"delivery",language:"en",description:"Useful curated guidance",robots_index:true,robots_follow:true,article_count:3}]);
    const page=await service.publicCategory("delivery","en");
    expect(page).toMatchObject({name:"Delivery Operations",article_count:3,robots_index:true});
    expect(page).not.toHaveProperty("id");
    expect(page.seo.canonical).toBe("https://tawseelhub.com/blog/category/delivery");
    expect(statements[0]).toContain("platform_blog_categories");
  });

  it("ignores private and tracking paths in 404 aggregation", async () => {
    const {service,statements}=fixture();
    await service.recordNotFound("/track?order=secret","https://example.com/private?q=secret");
    expect(statements).toHaveLength(0);
    await service.recordNotFound("/blog/missing?token=secret","https://example.com/path?q=secret");
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("token=secret");
    expect(statements[0]).not.toContain("q=secret");
  });

  it("reports production checks without inventing Search Console metrics", async () => {
    const { service } = fixture();
    const responses = new Map([
      ["/", ['text/html', '<link rel="canonical" href="https://tawseelhub.com/"/><script type="application/ld+json">{}</script>']],
      ["/robots.txt", ["text/plain", "User-agent: *\nAllow: /\nSitemap: https://tawseelhub.com/sitemap.xml"]],
      ["/sitemap.xml", ["application/xml", '<?xml version="1.0"?><urlset><url><loc>https://tawseelhub.com/</loc></url></urlset>']],
      ["/blog/rss.xml", ["application/rss+xml", "<rss><channel/></rss>"]],
      ["/ar/blog/rss.xml", ["application/rss+xml", "<rss><channel/></rss>"]],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const [contentType, body] = responses.get(path)!;
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    }));
    const result = await service.productionSeoHealth();
    expect(result).toMatchObject({ status: "healthy", sitemapUrlCount: 1, searchConsole: { integration: "manual" } });
    expect(result).not.toHaveProperty("clicks");
    vi.unstubAllGlobals();
  });
});
