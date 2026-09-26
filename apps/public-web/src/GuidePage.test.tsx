import { renderToString } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { GuidePage, guidePreloadKey } from "./GuidePage";
import { PreloadContext } from "./preload-context";

describe("GuidePage",()=>{
  it("renders full public Guide content without a Blog listing dependency",()=>{
    const guide={title:"Delivery Management Software UAE",slug:"delivery-management-software-uae",language:"en",summary:"A practical long-form guide.",content:[{type:"h2",text:"Choose the right platform"},{type:"paragraph",text:"Visible content for visitors and crawlers."}],robotsIndex:true,robotsFollow:true,seo:{canonical:"https://tawseelhub.com/guides/delivery-management-software-uae",title:"Delivery Management Software UAE",description:"A practical long-form guide.",alternates:[]}};
    const html=renderToString(<PreloadContext.Provider value={new Map([[guidePreloadKey(guide.slug,"en"),guide]])}><StaticRouter location={`/guides/${guide.slug}`}><Routes><Route path="/guides/:slug" element={<GuidePage/>}/></Routes></StaticRouter></PreloadContext.Provider>);
    expect(html).toContain(`<h1>${guide.title}</h1>`);
    expect(html).toContain("Visible content for visitors and crawlers.");
    expect(html).not.toContain("Blog");
  });
});
