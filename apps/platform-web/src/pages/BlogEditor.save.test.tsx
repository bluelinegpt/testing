import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlogEditor } from "./WebsiteContentPage.js";
import { platformApi } from "../api/platform-client.js";
vi.mock("../app/PlatformSession.js",()=>({usePlatformSession:()=>({can:()=>true})}));
vi.mock("./BlogArticleImport.js",()=>({BlogArticleImport:()=>null}));
const formatted='<h2>New section</h2><p><strong>Formatted text</strong></p>';
const initial={id:"article",slug:"test-article",title:"Test Article",excerpt:"An article excerpt",content:[{type:"paragraph",text:"Old body"}],language:"en",author_id:"author",category_id:"category",status:"draft",robots_index:true,robots_follow:true};
let stored:typeof initial;
beforeEach(()=>{stored=structuredClone(initial);vi.spyOn(platformApi,"blogReferences").mockResolvedValue({authors:[],categories:[]});vi.spyOn(platformApi,"websiteCms").mockResolvedValue({media:[]} as never);vi.spyOn(platformApi,"blogArticle").mockImplementation(async()=>structuredClone(stored));vi.spyOn(platformApi,"updateBlogArticle").mockImplementation(async(_id,input)=>{stored={...stored,content:input.content};return structuredClone(stored)});vi.spyOn(platformApi,"updateBlogArticleStatus").mockImplementation(async()=>({...stored,status:"published"}));vi.spyOn(window,"confirm").mockReturnValue(true)});
afterEach(()=>{cleanup();vi.restoreAllMocks()});
async function open(){render(<MemoryRouter><BlogEditor id="article"/></MemoryRouter>);await screen.findByText("All changes saved");fireEvent.click(screen.getByRole("button",{name:"HTML source"}));fireEvent.change(screen.getByRole("textbox",{name:"HTML source"}),{target:{value:formatted}})}
describe("blog save flow",()=>{
  it("sends HTML blocks and reopens the saved formatting",async()=>{await open();fireEvent.click(screen.getAllByRole("button",{name:"Save Draft"})[0]!);await screen.findByText("All changes saved");expect(platformApi.updateBlogArticle).toHaveBeenCalledWith("article",expect.objectContaining({content:[{type:"html",text:formatted}]}));cleanup();render(<MemoryRouter><BlogEditor id="article"/></MemoryRouter>);await screen.findByText("All changes saved");expect(screen.getByRole("textbox",{name:"Article body"}).querySelector("h2")?.textContent).toBe("New section");expect(screen.getByRole("textbox",{name:"Article body"}).querySelector("strong")?.textContent).toBe("Formatted text")});
  it("saves the current editor before publishing",async()=>{await open();fireEvent.click(screen.getByRole("button",{name:"Save & Publish"}));await waitFor(()=>expect(platformApi.updateBlogArticleStatus).toHaveBeenCalled());expect(vi.mocked(platformApi.updateBlogArticle).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(platformApi.updateBlogArticleStatus).mock.invocationCallOrder[0]!);expect(stored.content).toEqual([{type:"html",text:formatted}])});
  it("keeps edits and never publishes when save fails",async()=>{await open();vi.mocked(platformApi.updateBlogArticle).mockRejectedValue(new Error("Save rejected"));fireEvent.click(screen.getByRole("button",{name:"Save & Publish"}));await waitFor(()=>expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Save rejected"));expect(platformApi.updateBlogArticleStatus).not.toHaveBeenCalled();expect(screen.getByRole("textbox",{name:"HTML source"})).toHaveValue(formatted);expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()});
});
