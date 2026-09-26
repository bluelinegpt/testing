import { Module } from "@nestjs/common";
import { FilesModule } from "../files/files.module.js";
import { PublicSeoGuideController } from "./seo-guide.controller.js";
import { SeoGuideService } from "./seo-guide.service.js";

@Module({ imports: [FilesModule], controllers: [PublicSeoGuideController], providers: [SeoGuideService], exports: [SeoGuideService] })
export class SeoGuideModule {}
