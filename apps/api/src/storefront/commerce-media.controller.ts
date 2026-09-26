import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public, RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { commerceMediaLimits } from "../files/commerce-media.constants.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

import { CommerceMediaService, type UploadedBytes } from "./commerce-media.service.js";

/**
 * Commerce media upload.
 *
 * Every route names the RESOURCE the file is being attached to — a Storefront's
 * logo, a Product's image — and ownership is derived from that resource server
 * side. There is deliberately no generic "upload a Commerce file" endpoint that
 * takes a target identifier and an owner: such an endpoint is only as safe as
 * the caller's honesty about the owner it names.
 *
 * `FileInterceptor` enforces the byte ceiling at the transport layer so an
 * oversized upload is refused while streaming, before it is buffered whole.
 * `validateCommerceImage` then re-checks the size against the per-purpose limit,
 * because the transport limit is the larger of the two and the branding routes
 * are stricter.
 */
@ApiTags("commerce-media")
@ApiBearerAuth()
@RequireIdentityKinds("company_user", "trader")
@Controller("operations/trader-storefronts")
export class CommerceMediaController {
  public constructor(@Inject(CommerceMediaService) private readonly media: CommerceMediaService) {}

  @ApiOperation({ summary: "Upload or replace the Store logo (PNG/JPEG/WebP)" })
  @ApiConsumes("multipart/form-data")
  @Post(":storefrontId/media/logo")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: commerceMediaLimits.branding, files: 1 } }),
  )
  public uploadLogo(
    @Param("storefrontId") storefrontId: string,
    @UploadedFile() file: UploadedBytes | undefined,
  ) {
    return this.media.uploadStoreBranding(storefrontId, "logo", required(file));
  }

  @ApiOperation({ summary: "Upload or replace the Store cover image" })
  @ApiConsumes("multipart/form-data")
  @Post(":storefrontId/media/cover")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: commerceMediaLimits.branding, files: 1 } }),
  )
  public uploadCover(
    @Param("storefrontId") storefrontId: string,
    @UploadedFile() file: UploadedBytes | undefined,
  ) {
    return this.media.uploadStoreBranding(storefrontId, "cover", required(file));
  }

  @ApiOperation({ summary: "Remove the Store logo" })
  @HttpCode(200)
  @Delete(":storefrontId/media/logo")
  public async removeLogo(@Param("storefrontId") storefrontId: string) {
    await this.media.removeStoreBranding(storefrontId, "logo");
    return { removed: true };
  }

  @ApiOperation({ summary: "Remove the Store cover image" })
  @HttpCode(200)
  @Delete(":storefrontId/media/cover")
  public async removeCover(@Param("storefrontId") storefrontId: string) {
    await this.media.removeStoreBranding(storefrontId, "cover");
    return { removed: true };
  }

  @ApiOperation({ summary: "Upload a Product image and return its file id" })
  @ApiConsumes("multipart/form-data")
  @Post("products/:productId/media/image")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: commerceMediaLimits.product, files: 1 } }),
  )
  public uploadProductImage(
    @Param("productId") productId: string,
    @UploadedFile() file: UploadedBytes | undefined,
  ) {
    return this.media.uploadProductImage(productId, required(file));
  }
}

function required(file: UploadedBytes | undefined): UploadedBytes {
  if (file === undefined) {
    throw new ApplicationException(
      "commerce_media_required",
      "A file is required under the 'file' field",
      400,
    );
  }
  return file;
}

/**
 * Public Commerce media bytes.
 *
 * Addressed by file id and nothing else. The id reveals no owner, and the
 * service refuses any file that is not `owner_type = 'trader_commerce'`, is
 * soft-deleted, or has not passed validation — so a Company operational
 * attachment can never be fetched through this route even with a correct id.
 *
 * A quarantined or missing file returns the same not-found as an unknown id,
 * because distinguishing them would confirm that a particular file exists.
 */
@ApiTags("public-commerce-media")
@Controller("public/commerce-media")
export class PublicCommerceMediaController {
  public constructor(@Inject(CommerceMediaService) private readonly media: CommerceMediaService) {}

  @Public()
  @ApiOperation({ summary: "Stream public Commerce media bytes" })
  @Get(":fileId")
  public async read(@Param("fileId") fileId: string, @Res() response: Response): Promise<void> {
    const content = await this.media.readPublic(fileId);
    response.setHeader("Content-Type", content.mediaType);
    // Immutable: the storage key carries a UUID, so a given id's bytes never
    // change. A replacement is a different file with a different id.
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(Buffer.from(content.bytes));
  }
}
