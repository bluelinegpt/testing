// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlogEnquiry, blogWhatsAppUrl } from "./BlogEnquiry";
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
function fill(){fireEvent.change(screen.getByLabelText("Your name"),{target:{value:"Test Customer"}});fireEvent.change(screen.getByLabelText("Your email"),{target:{value:"customer@example.com"}});fireEvent.change(screen.getByLabelText("Your message"),{target:{value:"Please tell me more about this"}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.submit(screen.getByRole("button",{name:"Send enquiry"}).closest("form")!)}
describe("private blog enquiries",()=>{
  it("submits the article context and explicit consent",async()=>{const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({sent:true})});vi.stubGlobal("fetch",fetch);render(<BlogEnquiry slug="test-article" language="en"/>);fill();await screen.findByRole("status");expect(fetch.mock.calls[0]?.[0]).toContain("/articles/test-article/enquiry");expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({consent:true,email:"customer@example.com",language:"en"});expect(screen.getByRole("link")).toHaveAttribute("href",blogWhatsAppUrl)});
  it("retains the form and message on send failure",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false,status:503}));render(<BlogEnquiry slug="test" language="en"/>);fill();await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("could not be sent"));expect(screen.getByLabelText("Your message")).toHaveValue("Please tell me more about this");expect(screen.queryByRole("status")).toBeNull()});
  it("provides Arabic labels and RTL",()=>{render(<BlogEnquiry slug="test" language="ar"/>);expect(screen.getByLabelText("البريد الإلكتروني")).toBeInTheDocument();expect(screen.getByRole("button")).toHaveTextContent("إرسال الاستفسار")});
});
