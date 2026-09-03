import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validate } from "class-validator";
import nodemailer from "nodemailer";
import { BlogEnquiryDto, BlogEnquiryService } from "./blog-enquiry.js";
import type { BlogService } from "./blog.service.js";
const input=Object.assign(new BlogEnquiryDto(),{name:"Test Customer",email:"customer@example.com",message:"Please send more details",consent:true});
const article={publicArticle:vi.fn().mockResolvedValue({article:{title:"Test article"}})};
const service=()=>new BlogEnquiryService(article as unknown as BlogService);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()});
describe("blog enquiry",()=>{
  it("validates email and consent",async()=>{expect(await validate(input)).toEqual([]);expect((await validate(Object.assign(new BlogEnquiryDto(),input,{email:"bad",consent:false})))).toHaveLength(2)});
  it("rejects spam trap submissions",async()=>{await expect(service().send("article",{...input,website:"spam"})).rejects.toThrow("Unable to submit")});
  it("does not report success with missing SMTP",async()=>{vi.stubEnv("SMTP_HOST","");await expect(service().send("article",input)).rejects.toThrow("not configured")});
  it("sends only to the approved recipient and uses reply-to",async()=>{for(const [k,v] of Object.entries({SMTP_HOST:"smtp.example.com",SMTP_USER:"user",SMTP_PASSWORD:"test",SMTP_FROM:"sender@example.com",SMTP_PORT:"587"}))vi.stubEnv(k,v);const sendMail=vi.fn().mockResolvedValue({accepted:["aothman@gmail.com"]});vi.spyOn(nodemailer,"createTransport").mockReturnValue({sendMail,close:vi.fn()} as never);expect(await service().send("article",input)).toEqual({sent:true});expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({to:"aothman@gmail.com",replyTo:"customer@example.com"}));});
  it("reports a sanitized failure, never SMTP secrets",async()=>{for(const k of ["SMTP_HOST","SMTP_USER","SMTP_PASSWORD","SMTP_FROM"])vi.stubEnv(k,"test");vi.stubEnv("SMTP_PORT","587");vi.spyOn(nodemailer,"createTransport").mockReturnValue({sendMail:vi.fn().mockRejectedValue(new Error("secret provider data")),close:vi.fn()} as never);await expect(service().send("article",input)).rejects.toThrow("could not be sent")});
});
