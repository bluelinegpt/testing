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
  @Get("media/:id")
  @Header("Cache-Control", "public, max-age=86400, immutable")
  public async media(@Param("id") id: string, @Res() response: Response) {
    const file = await this.cms.readMedia(id);
    response.type(file.mediaType);
    response.send(Buffer.from(file.bytes));
  }
}
