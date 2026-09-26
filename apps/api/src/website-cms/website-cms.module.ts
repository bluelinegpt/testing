import { Module } from "@nestjs/common";

import { FilesModule } from "../files/files.module.js";
import { PublicWebsiteCmsController } from "./public-website-cms.controller.js";
import { WebsiteCmsService } from "./website-cms.service.js";

@Module({
  controllers: [PublicWebsiteCmsController],
  exports: [WebsiteCmsService],
  imports: [FilesModule],
  providers: [WebsiteCmsService],
})
export class WebsiteCmsModule {}
