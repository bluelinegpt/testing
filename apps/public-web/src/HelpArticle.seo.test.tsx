import { describe, expect, it } from "vitest";
import { render } from "./entry-server";

describe("Help server rendering",()=>{
  it("renders an English fallback as English content in the Arabic layout",()=>{
    const article={slug:"create-an-order",locale:"en",title:"Create an order",summary:"Verified English content",body:[{type:"paragraph",text:"Actual steps appear before JavaScript runs."}]};
    const html=render("/ar/resources/create-an-order",new Map([["help-article:create-an-order:ar",{article,related:[{slug:"contact-support",locale:"en",title:"Contact support"}]}]]));
    expect(html).toContain('lang="en" dir="ltr"');
    expect(html).toContain("Actual steps appear before JavaScript runs.");
    expect(html).toContain('href="/resources/contact-support"');
  });
  it("links Arabic Help search/list cards to the real content language",()=>{
    const html=render("/ar/resources",new Map([["help-home:ar",{locale:"ar",categories:[],articles:[{slug:"create-an-order",locale:"en",title:"Create an order",summary:"English fallback"},{slug:"translated",locale:"ar",title:"دليل عربي",summary:"خطوات"}]}]]));
    expect(html).toContain('href="/resources/create-an-order"');
    expect(html).not.toContain('href="/ar/resources/create-an-order"');
    expect(html).toContain('href="/ar/resources/translated"');
  });
});
