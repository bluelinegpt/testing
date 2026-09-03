import { describe, expect, it } from "vitest";
import { cleanBlogHtml } from "./blog-html.js";
describe("blog HTML",()=>{
  it("retains inline formatting through repeated saves",()=>{const input='<h2>Section</h2><p><span style="font-weight:700;font-style:italic;text-decoration:underline;font-size:24px">Styled</span></p>';const saved=cleanBlogHtml(input);expect(saved).toContain('font-weight:700');expect(saved).toContain('font-style:italic');expect(saved).toContain('text-decoration:underline');expect(cleanBlogHtml(saved)).toBe(saved)});
  it("preserves headings, formatting, images and approved styles",()=>{const result=cleanBlogHtml('<h2>Title</h2><p><strong>Hello</strong> <span style="font-size:24px;font-family:Georgia">World</span></p><img src="/api/v1/public/website/media/example" alt="Photo" style="width:50%">');expect(result).toContain('<h2>Title</h2>');expect(result).toContain('font-size:24px');expect(result).toContain('width:50%');expect(result).toContain('alt="Photo"')});
  it("removes scripts, forms, unsafe URLs, handlers and overlay CSS",()=>{const result=cleanBlogHtml('<script>alert(1)</script><form action="https://evil.test"><input></form><img src="javascript:alert(1)" onerror="alert(2)"><p style="position:fixed;font-size:24px;background:url(https://evil.test)">Safe</p><a href="javascript:alert(1)">Link</a>');expect(result).not.toMatch(/script|onerror|javascript|position|background|<form|<input/);expect(result).toContain('font-size:24px')});
  it("keeps one H1 owned by the article title",()=>expect(cleanBlogHtml('<h1>Section</h1>')).toBe('<h2>Section</h2>'));
  it("blocks protocol-relative and data images",()=>expect(cleanBlogHtml('<img src="//evil.test/x"><img src="data:image/svg+xml,x">')).toBe(""));
});
