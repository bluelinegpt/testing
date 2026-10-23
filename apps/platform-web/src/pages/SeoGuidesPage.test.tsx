// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { platformApi } from "../api/platform-client.js";
import { SeoGuidesPage } from "./SeoGuidesPage.js";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("keeps the public link tied to the saved page while an editor changes the slug", async()=>{
  const row={id:"guide-1",internal_title:"Arabic delivery software",title:"Delivery software",slug:"delivery-software",language:"ar",status:"published",content:[]};
  vi.spyOn(platformApi,"seoGuides").mockResolvedValue([row]);
  vi.spyOn(platformApi,"seoGuide").mockResolvedValue(row);
  vi.spyOn(platformApi,"seoGuideReadiness").mockResolvedValue({status:"seo_ready",checks:[]});
  render(<MemoryRouter initialEntries={["/website/seo-guides/guide-1"]}><Routes><Route path="/website/seo-guides/:id" element={<SeoGuidesPage/>}/></Routes></MemoryRouter>);
  const link=await screen.findByRole("link",{name:"Open published page ↗"});
  fireEvent.change(screen.getByLabelText("Slug"),{target:{value:"unsaved-slug"}});
  expect(link.getAttribute("href")).toBe("https://tawseelhub.com/ar/delivery-software");
  expect(screen.getByRole("button",{name:"Save changes"})).toBeTruthy();
});
