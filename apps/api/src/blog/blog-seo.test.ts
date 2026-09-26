import { describe, expect, it } from "vitest";
import { localizedBlogPath, publicArticleSeo, safeCanonical, validateLocalizedSlug } from "./blog.service.js";
describe("blog technical SEO validation", () => {
  it("rejects Render and query-string canonicals", () => {
    for (const canonicalUrl of ["https://example.onrender.com/blog/x", "https://tawseelhub.com/blog/x?utm_source=test"]) {
      expect(() => safeCanonical(canonicalUrl)).toThrow("invalid_blog_canonical");
    }
  });
  it("accepts and normalizes a production canonical", () => {
    expect(safeCanonical("https://tawseelhub.com/blog/technical-seo/")).toBe("https://tawseelhub.com/blog/technical-seo");
  });
  it("rejects a canonical owned by another article", () => {
    expect(() => safeCanonical("https://tawseelhub.com/blog/other", "/blog/technical-seo")).toThrow("invalid_blog_canonical");
  });
  it("builds one canonical schema graph with social override fallbacks", () => {
    const seo = publicArticleSeo({ slug:"cod-reconciliation-uae", language:"en", title:"COD Reconciliation", excerpt:"Visible description", seo_title:"SEO title", social_title:"Social title", social_description:"Social description", social_image_url:"/api/v1/public/website/media/image", social_image_alt:"COD reconciliation dashboard", social_image_width:1200, social_image_height:630, category:"COD & Finance", category_slug:"cod-finance", author:"Haseeb", published_at:"2026-09-01T00:00:00.000Z", updated_content_at:"2026-09-02T00:00:00.000Z" });
    expect(seo).toMatchObject({ canonical:"https://tawseelhub.com/blog/cod-reconciliation-uae", title:"Social title", description:"Social description", imageAlt:"COD reconciliation dashboard", imageWidth:1200, imageHeight:630 });
    const posting = seo.graph["@graph"].find((item:any)=>item["@type"]==="BlogPosting");
    expect(posting).toMatchObject({ headline:"COD Reconciliation", articleSection:"COD & Finance", inLanguage:"en", author:{"@type":"Person",name:"Haseeb"}, mainEntityOfPage:{"@id":seo.canonical} });
    expect(JSON.stringify(seo.graph)).not.toContain("author_id");
  });
  it("accepts Arabic slugs and rejects reserved or unsafe segments", () => {
    expect(validateLocalizedSlug("برنامج-إدارة-التوصيل")).toBe("برنامج-إدارة-التوصيل");
    expect(localizedBlogPath("ar","برنامج-إدارة-التوصيل")).toBe("/ar/blog/برنامج-إدارة-التوصيل");
    expect(()=>validateLocalizedSlug("category")).toThrow("blog_slug_reserved");
    expect(()=>validateLocalizedSlug("../مقال")).toThrow();
  });
  it("localizes Arabic canonical, alternates and structured data", () => {
    const seo=publicArticleSeo({slug:"برنامج-إدارة-التوصيل",language:"ar",title:"برنامج إدارة التوصيل",excerpt:"وصف عربي للمقال",category:"الخدمات اللوجستية",category_slug:"الخدمات-اللوجستية",author:"فريق Tawseelhub",published_at:"2026-09-01T00:00:00.000Z",translation_slug:"delivery-management",translation_language:"en"});
    expect(seo).toMatchObject({canonical:"https://tawseelhub.com/ar/blog/برنامج-إدارة-التوصيل",locale:"ar_AE",alternateLocale:"en_AE",xDefault:"https://tawseelhub.com/blog/delivery-management"});
    expect(seo.alternates).toEqual(expect.arrayContaining([{language:"ar",url:seo.canonical},{language:"en",url:"https://tawseelhub.com/blog/delivery-management"}]));
    const posting=seo.graph["@graph"].find((item:any)=>item["@type"]==="BlogPosting");
    const breadcrumb=seo.graph["@graph"].find((item:any)=>item["@type"]==="BreadcrumbList");
    expect(posting!.inLanguage).toBe("ar");
    expect(breadcrumb!.itemListElement[0]).toMatchObject({name:"الرئيسية",item:"https://tawseelhub.com/ar"});
  });
});
