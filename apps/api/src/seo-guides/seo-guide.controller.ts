import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { Public } from "../authentication/authentication.decorators.js";
import { SeoGuideService } from "./seo-guide.service.js";

@Controller("public/guides")
export class PublicSeoGuideController {
  constructor(@Inject(SeoGuideService) private readonly guides: SeoGuideService) {}
  @Public() @Get(":slug") guide(@Param("slug") slug: string, @Query("language") language?: string) {
    return this.guides.publicGuide(slug, language);
  }
}
