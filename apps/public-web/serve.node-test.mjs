import test from "node:test";
import assert from "node:assert/strict";
import { cacheControlFor, encodedBody, injectArticleMetadata, injectLandingMetadata, isOriginHost, normalizePath, robotsHeader } from "./serve.mjs";
test("normalizes public paths", () => { assert.equal(normalizePath("//blog/example///"), "/blog/example"); assert.equal(normalizePath("/"), "/"); });
test("recognizes Render origins", () => assert.equal(isOriginHost("site.onrender.com"), true));
test("non-production is noindex", () => assert.equal(robotsHeader("tawseelhub.com"), "noindex, nofollow"));
test("immutable bundles and compressible responses use production-safe delivery", () => {
  assert.equal(cacheControlFor("/assets/index-abc.js", "text/javascript"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/blog/article", "text/html"), "public, max-age=60, stale-while-revalidate=300");
  const compressed = encodedBody("x".repeat(5000), "text/html; charset=utf-8", "br, gzip");
  assert.equal(compressed.encoding, "br");
  assert.ok(compressed.body.length < 5000);
});
test("initial article HTML contains safe structured and social metadata", () => {
  const graph={"@context":"https://schema.org","@graph":[{"@type":"BlogPosting",headline:'Unsafe </script><script>alert(1)</script>'}]};
  const html=injectArticleMetadata('<html><head><title>Old</title><meta name="description" content="Old" /></head></html>',{language:"en",title:'Title "quoted"',excerpt:"Description",robots_index:true,robots_follow:true,seo:{canonical:"https://tawseelhub.com/blog/safe",title:"Social",description:"Share",image:"https://tawseelhub.com/image.jpg",imageAlt:'Alt "text"',imageWidth:1200,imageHeight:630,graph}},"/blog/safe");
  assert.match(html,/property="og:url" content="https:\/\/tawseelhub.com\/blog\/safe"/);
  assert.match(html,/name="twitter:card" content="summary_large_image"/);
  assert.match(html,/"@type":"BlogPosting"/);
  assert.doesNotMatch(html,/<\/script><script>alert/);
  assert.match(html,/\\u003c\/script>/);
});
test("initial Arabic article HTML is RTL and contains reciprocal language metadata",()=>{
  const html=injectArticleMetadata('<html lang="en"><head><title>Old</title><meta name="description" content="Old" /></head></html>',{language:"ar",title:"عنوان عربي",excerpt:"وصف عربي",robots_index:true,robots_follow:true,seo:{canonical:"https://tawseelhub.com/ar/blog/مقال",alternates:[{language:"ar",url:"https://tawseelhub.com/ar/blog/مقال"},{language:"en",url:"https://tawseelhub.com/blog/article"}],xDefault:"https://tawseelhub.com/blog/article",alternateLocale:"en_AE"}},"/ar/blog/مقال");
  assert.match(html,/<html lang="ar" dir="rtl">/);
  assert.match(html,/hreflang="ar" href="https:\/\/tawseelhub.com\/ar\/blog\/مقال"/);
  assert.match(html,/hreflang="en" href="https:\/\/tawseelhub.com\/blog\/article"/);
  assert.match(html,/property="og:locale" content="ar_AE"/);
});
test("initial taxonomy HTML contains canonical, schema, noindex policy and RSS discovery",()=>{
  const html=injectLandingMetadata('<html lang="en"><head><title>Old</title><meta name="description" content="Old" /></head></html>',{name:"COD & Finance",language:"en",robots_index:false,robots_follow:true,seo:{title:"COD guides",description:"Curated COD guidance",canonical:"https://tawseelhub.com/blog/tag/cod",alternates:[{language:"en",url:"https://tawseelhub.com/blog/tag/cod"}],graph:{"@context":"https://schema.org","@type":"CollectionPage"}}});
  assert.match(html,/name="robots" content="noindex,follow,max-image-preview:large"/);
  assert.match(html,/rel="canonical" href="https:\/\/tawseelhub.com\/blog\/tag\/cod"/);
  assert.match(html,/type="application\/rss\+xml"/);
  assert.match(html,/CollectionPage/);
});
