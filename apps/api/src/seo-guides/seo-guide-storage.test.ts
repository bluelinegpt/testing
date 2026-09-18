import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("SEO Guide source-document protections", () => {
  it("keeps source objects in their own private namespace without public routes or delete coupling", async () => {
    const migration=await readFile(new URL("../../../../database/migrations/20260970000000_seo_guides.ts",import.meta.url),"utf8");
    expect(migration).toContain("platform_seo_guide_source_documents");
    expect(migration).toContain("references platform_seo_guides(id) on delete restrict");
    const sourceTable=migration.split("create table platform_seo_guide_source_documents")[1]?.split("create table platform_seo_guide_publication_history")[0]??"";
    expect(sourceTable).not.toContain("public_url");
    const service=await readFile(new URL("./seo-guide.service.ts",import.meta.url),"utf8");
    expect(service).toContain("seo-source-documents/");
    expect(service).not.toMatch(/deleteSeoSource|deleteSeoGuideSource/);
  });
  it("stays independent from Blog storage and listing queries",async()=>{
    const blog=await readFile(new URL("../blog/blog.service.ts",import.meta.url),"utf8");
    expect(blog).not.toContain("platform_seo_guides");
    const sitemap=await readFile(new URL("../website-cms/website-cms.service.ts",import.meta.url),"utf8");
    expect(sitemap).toContain("from platform_seo_guides");
    expect(sitemap).toContain("include_in_sitemap = true");
  });
});
