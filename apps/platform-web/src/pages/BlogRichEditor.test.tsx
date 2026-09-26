import { describe, expect, it } from "vitest";
import { blocksToHtml, plainBlogHtml, safeEditorHtml } from "./BlogRichEditor.js";
describe("blog editor conversion",()=>{
  it("retains inline bold, italic and underline when reopened",()=>{const saved=safeEditorHtml('<span style="font-weight:700;font-style:italic;text-decoration:underline">Styled</span>');expect(saved).toContain('font-weight:700');expect(saved).toContain('font-style:italic');expect(saved).toContain('text-decoration:underline');expect(safeEditorHtml(saved)).toBe(saved)});
  it("keeps a pasted H1 as a section heading instead of dropping its structure",()=>expect(safeEditorHtml('<h1>Title</h1>')).toBe('<h2>Title</h2>'));
  it("preserves legacy headings and lists",()=>expect(blocksToHtml([{type:"h2",text:"Section"},{type:"bullet_list",items:["One","Two"]}])).toBe('<h2>Section</h2><ul><li>One</li><li>Two</li></ul>'));
  it("does not interpret text imports as HTML",()=>expect(plainBlogHtml('<script>bad</script>')).toBe('<p>&lt;script&gt;bad&lt;/script&gt;</p>'));
  it("preserves HTML across reopen",()=>expect(blocksToHtml([{type:"html",text:'<p><b>Bold</b></p>'}])).toBe('<p><b>Bold</b></p>'));
  it("removes executable markup in editor preview",()=>expect(safeEditorHtml('<script>bad()</script><p onclick="bad()">Safe</p>')).toBe('<p>Safe</p>'));
});
