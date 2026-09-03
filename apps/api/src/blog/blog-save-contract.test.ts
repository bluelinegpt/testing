import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { SaveBlogArticleDto } from "./blog.dto.js";

// Load the actual frontend serializer, rather than mocking away request validation.
const serializerPath = "../../../platform-web/src/pages/blog-save-payload.ts";
const { blogSavePayload } = await import(new URL(serializerPath, import.meta.url).href);
const pipe = new ValidationPipe({forbidNonWhitelisted:true,stopAtFirstError:false,transform:true,whitelist:true});
const form={id:"article-id",status:"draft",created_at:"2026-09-03",updated_at:"2026-09-03",author_id:"db-author",draft_payload:{},has_unpublished_changes:true,
  slug:"test-article",language:"en",title:"Test article title",excerpt:"An excerpt long enough for validation",content:'<h2>Heading</h2><p><b>Body</b></p>',authorId:"a27fb1be-b477-4c5e-9635-0acaeb711581",categoryId:"a27fb1be-b477-4c5e-9635-0acaeb711582",robotsIndex:true,robotsFollow:true,featuredImagePublicUrl:"/api/v1/public/website/media/474be658-8c91-41fb-8cd9-0790bfd096d5",featuredImageAlt:"Blog image",canonicalUrl:"",socialImageUrl:""};
describe("blog editor / API save contract",()=>{
  it("reproduces the 400 when response fields are spread into the request",async()=>{await expect(pipe.transform({...form,content:[{type:"html",text:form.content}]},{type:"body",metatype:SaveBlogArticleDto})).rejects.toThrow()});
  it("accepts the actual frontend payload under production validation",async()=>{const payload=blogSavePayload(form);const saved=await pipe.transform(payload,{type:"body",metatype:SaveBlogArticleDto});expect(saved.content[0].text).toBe(form.content);expect(saved.featuredImagePublicUrl).toBe(form.featuredImagePublicUrl);expect(payload).not.toHaveProperty("id");expect(payload).not.toHaveProperty("status");expect(payload).not.toHaveProperty("author_id");expect(payload).not.toHaveProperty("draft_payload")});
});
