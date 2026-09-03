import { Module } from "@nestjs/common";
import { AuthenticationModule } from "../authentication/authentication.module.js";
import { PublicBlogController } from "./blog.controller.js";
import { BlogService } from "./blog.service.js";
import { BlogImportService } from "./blog-import.service.js";
import { BlogEnquiryController, BlogEnquiryService } from "./blog-enquiry.js";
@Module({ imports: [AuthenticationModule], controllers: [PublicBlogController, BlogEnquiryController], providers: [BlogService, BlogImportService, BlogEnquiryService], exports: [BlogService, BlogImportService] })
export class BlogModule {}
