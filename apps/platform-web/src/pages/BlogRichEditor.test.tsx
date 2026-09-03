import { describe, expect, it } from "vitest";
import { blocksToHtml, plainBlogHtml, safeEditorHtml } from "./BlogRichEditor.js";
describe("blog editor conversion",()=>{
  it("preserves legacy headings and lists",()=>expect(blocksToHtml([{type:"h2",text:"Section"},{type:"bullet_list",items:["One","Two"]}])).toBe('<h2>Section</h2><ul><li>One</li><li>Two</li></ul>'));
  it("does not interpret text imports as HTML",()=>expect(plainBlogHtml('<script>bad</script>')).toBe('<p>&lt;script&gt;bad&lt;/script&gt;</p>'));
  it("preserves HTML across reopen",()=>expect(blocksToHtml([{type:"html",text:'<p><b>Bold</b></p>'}])).toBe('<p><b>Bold</b></p>'));
  it("removes executable markup in editor preview",()=>expect(safeEditorHtml('<script>bad()</script><p onclick="bad()">Safe</p>')).toBe('<p>Safe</p>'));
});
