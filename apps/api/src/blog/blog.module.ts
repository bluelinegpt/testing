import { Module } from "@nestjs/common";
import { AuthenticationModule } from "../authentication/authentication.module.js";
import { PublicBlogController } from "./blog.controller.js";
import { BlogService } from "./blog.service.js";
import { BlogImportService } from "./blog-import.service.js";
@Module({ imports: [AuthenticationModule], controllers: [PublicBlogController], providers: [BlogService, BlogImportService], exports: [BlogService, BlogImportService] })
export class BlogModule {}
