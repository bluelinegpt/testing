import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../authentication/authentication.decorators.js";
import { BlogService } from "./blog.service.js";
import { PublicNotFoundDto } from "./blog.dto.js";
@Controller("public/blog")
export class PublicBlogController {
  constructor(@Inject(BlogService) private readonly blog: BlogService) {}
  @Public() @Get() list(
    @Query("language") language?: string,
    @Query("category") category?: string,
    @Query("tag") tag?: string,
    @Query("author") author?: string,
    @Query("topic") topic?: string,
    @Query("page") page?: string,
  ) {
    return this.blog.publicList({
      ...(language === undefined ? {} : { language }),
      ...(category === undefined ? {} : { category }),
      ...(tag === undefined ? {} : { tag }),
      ...(author === undefined ? {} : { author }),
      ...(topic === undefined ? {} : { topic }),
      page: Number(page) || 1,
    });
  }
  @Public() @Get("categories") categories(@Query("language") language?: string) {
    return this.blog.categories(language);
  }
  @Public() @Get("categories/:slug") category(@Param("slug") slug:string,@Query("language") language?:string){return this.blog.publicCategory(slug,language);}
  @Public() @Get("tags") tags(@Query("language") language?:string){return this.blog.publicTags(language);}
  @Public() @Get("tags/:slug") tag(@Param("slug") slug:string,@Query("language") language?:string){return this.blog.publicTag(slug,language);}
  @Public() @Get("authors/:slug") author(@Param("slug") slug:string,@Query("language") language?:string){return this.blog.publicAuthor(slug,language);}
  @Public() @Get("topics") topics(@Query("language") language?:string){return this.blog.publicTopics(language);}
  @Public() @Get("topics/:slug") topic(@Param("slug") slug:string,@Query("language") language?:string){return this.blog.publicTopic(slug,language);}
  @Public() @Get("rss.xml") @Header("Content-Type","application/rss+xml; charset=utf-8") async rss(@Query("language")language:string|undefined,@Res()response:Response){response.status(200).send(await this.blog.rss(language));}
  @Public() @Post("not-found") @HttpCode(204) @Throttle({default:{limit:30,ttl:60_000}}) async notFound(@Body()body:PublicNotFoundDto){await this.blog.recordNotFound(body.path,body.referer);}
  @Public() @Get("redirect") redirect(@Query("path")path:string){return this.blog.resolveRedirect(path);}
  @Public() @Get("articles/:slug") article(
    @Param("slug") slug: string,
    @Query("language") language?: string,
  ) {
    return this.blog.publicArticle(slug, language);
  }
  @Public() @Get("settings") settings() {
    return this.blog.publicSettings();
  }
  @Public() @Get("sitemap-entries") sitemap() {
    return this.blog.sitemap();
  }
}
