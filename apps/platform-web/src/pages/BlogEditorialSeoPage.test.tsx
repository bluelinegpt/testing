import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi } from "../api/platform-client.js";
import { BlogEditorialSeoPage } from "./BlogEditorialSeoPage.js";

vi.mock("../app/PlatformSession.js",()=>({usePlatformSession:()=>({can:()=>true})}));

beforeEach(()=>{
  vi.spyOn(platformApi,"blogReferences").mockResolvedValue({categories:[{id:"category",name:"Delivery Operations",slug:"delivery-operations",language:"en",description:"Curated delivery guidance",robots_index:true,robots_follow:true,active:true,sort_order:10}],tags:[],topics:[],authors:[],articles:[{id:"article",title:"Delivery guide",language:"en",status:"published",category:"Delivery Operations"}]});
  vi.spyOn(platformApi,"blogSeoHealth").mockResolvedValue({missingMeta:1,missingImage:2,missingAlt:3,noindexPublished:0,orphanArticles:1,reviewRecommended:2});
  vi.spyOn(platformApi,"blogRedirects").mockResolvedValue([]);
  vi.spyOn(platformApi,"blogNotFoundPaths").mockResolvedValue([]);
  vi.spyOn(platformApi,"blogProductionSeoHealth").mockResolvedValue({status:"healthy",checkedAt:"2026-09-05T00:00:00Z",sitemapUrlCount:42,checks:[{key:"sitemap",pass:true,message:"Sitemap HTTP 200; 42 URLs"}]});
  vi.spyOn(platformApi,"updateBlogCategory").mockResolvedValue({});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe("Blog editorial SEO CMS",()=>{
  it("shows operational health counts without presenting a ranking score",async()=>{
    render(<MemoryRouter><BlogEditorialSeoPage/></MemoryRouter>);
    expect(await screen.findByText("Missing meta")).toBeInTheDocument();
    expect(screen.getByText("Orphan articles")).toBeInTheDocument();
    expect(screen.getByText(/not Google ranking scores/i)).toBeInTheDocument();
  });
  it("allows an authorized editor to manage category SEO and indexability",async()=>{
    render(<MemoryRouter><BlogEditorialSeoPage/></MemoryRouter>);
    await screen.findByText("Missing meta");
    fireEvent.click(screen.getByRole("button",{name:"Categories"}));
    fireEvent.click(screen.getByText("Delivery Operations"));
    expect(screen.getByRole("textbox",{name:"Description"})).toHaveValue("Curated delivery guidance");
    fireEvent.change(screen.getByRole("textbox",{name:"SEO title"}),{target:{value:"Delivery Operations UAE"}});
    fireEvent.click(screen.getByRole("button",{name:"Save category"}));
    await waitFor(()=>expect(platformApi.updateBlogCategory).toHaveBeenCalledWith("category",expect.objectContaining({seoTitle:"Delivery Operations UAE",robotsIndex:true})));
  });
  it("shows live technical status without fake Google metrics",async()=>{
    render(<MemoryRouter><BlogEditorialSeoPage/></MemoryRouter>);
    await screen.findByText("Production SEO");
    fireEvent.click(screen.getByRole("button",{name:"Run live checks"}));
    expect(await screen.findByText(/Sitemap HTTP 200/)).toBeInTheDocument();
    expect(screen.getByText(/not real-time metrics/i)).toBeInTheDocument();
  });
});
