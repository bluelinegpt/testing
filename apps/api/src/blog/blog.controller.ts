import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { Public } from "../authentication/authentication.decorators.js";
import { BlogService } from "./blog.service.js";
@Controller("public/blog")
export class PublicBlogController {
  constructor(@Inject(BlogService) private readonly blog: BlogService) {}
  @Public() @Get() list(
    @Query("language") language?: string,
    @Query("category") category?: string,
    @Query("page") page?: string,
  ) {
    return this.blog.publicList({
      ...(language === undefined ? {} : { language }),
      ...(category === undefined ? {} : { category }),
      page: Number(page) || 1,
    });
  }
  @Public() @Get("categories") categories(@Query("language") language?: string) {
    return this.blog.categories(language);
  }
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
