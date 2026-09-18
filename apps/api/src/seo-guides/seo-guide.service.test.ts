import { describe, expect, it } from "vitest";
import { localizedGuidePath, publicGuideSeo, toPublicGuide } from "./seo-guide.service.js";

describe("SEO Guide public contract", () => {
  it("uses independent crawlable English and Arabic paths", () => {
    expect(localizedGuidePath("en","delivery-management-software-uae")).toBe("/guides/delivery-management-software-uae");
    expect(localizedGuidePath("ar","برنامج-إدارة-التوصيل")).toBe("/ar/guides/برنامج-إدارة-التوصيل");
  });
  it("emits WebPage rather than BlogPosting schema with reciprocal hreflang", () => {
    const seo=publicGuideSeo({language:"en",slug:"delivery-software",title:"Delivery Software",summary:"A complete guide.",published_at:"2026-09-18T00:00:00Z",updated_at:"2026-09-18T00:00:00Z",translation_slug:"برنامج-التوصيل",translation_language:"ar",translation_status:"published"});
    expect(seo.canonical).toBe("https://tawseelhub.com/guides/delivery-software");
    expect(seo.alternates).toEqual(expect.arrayContaining([{language:"ar",url:"https://tawseelhub.com/ar/guides/برنامج-التوصيل"}]));
    const serialized=JSON.stringify(seo.graph);
    expect(serialized).toContain('"@type":"WebPage"');
    expect(serialized).not.toContain("BlogPosting");
  });
  it("never exposes private source or audit fields in the public DTO", () => {
    const dto=toPublicGuide({id:"guide",title:"Guide",slug:"guide",language:"en",summary:"Summary",content:[],robots_index:true,robots_follow:true,storage_key:"seo-source-documents/private.docx",created_by_account_id:"actor",sources:[{storage_key:"private"}]});
    expect(JSON.stringify(dto)).not.toContain("storage_key");
    expect(JSON.stringify(dto)).not.toContain("created_by_account_id");
    expect(dto).not.toHaveProperty("sources");
  });
});
