import { Controller, Get, Header, Inject, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { Public } from "../authentication/authentication.decorators.js";
import { WebsiteCmsService } from "./website-cms.service.js";

@Controller("public/website")
export class PublicWebsiteCmsController {
  public constructor(@Inject(WebsiteCmsService) private readonly cms: WebsiteCmsService) {}

  @Public()
  @Get("content")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  public content(@Query("locale") locale?: string) {
    return this.cms.publicBundle(locale);
  }

  @Public()
  @Get("sitemap-entries")
  @Header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600")
  public sitemapEntries() {
    return this.cms.sitemapEntries();
  }

  @Public()
  @Get("help")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  public helpHome(@Query("locale") locale?: string) {
    return this.cms.helpHome(locale);
  }

  @Public()
  @Get("help/search")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  public helpSearch(@Query("locale") locale?: string, @Query("q") query?: string, @Query("audience") audience?: string, @Query("category") category?: string) {
    return this.cms.helpSearch(locale, query, audience, category);
  }

  @Public()
  @Get("help/articles/:slug")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  public helpArticle(@Param("slug") slug: string, @Query("locale") locale?: string) {
    return this.cms.helpArticle(slug, locale);
  }

  @Public()
  @Get("media/:id")
  @Header("Cache-Control", "public, max-age=86400, immutable")
  // Public CMS media is intentionally embedded by the separate public-site
  // origin (for example tawseelhub.com). Helmet otherwise defaults CORP to
  // `same-origin`, which makes browsers reject these successful image
  // responses with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
  @Header("Cross-Origin-Resource-Policy", "cross-origin")
  public async media(@Param("id") id: string, @Res() response: Response) {
    const file = await this.cms.readMedia(id);
    response.type(file.mediaType);
    response.send(Buffer.from(file.bytes));
  }
}
