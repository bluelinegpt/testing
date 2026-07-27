import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import {
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
import { MAX_LOGO_BYTES } from "../files/image-signature.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  type CompanyBranding,
  type CompanyProfile,
  CompanyProfileService,
} from "./company-profile.service.js";
// Runtime class value is required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UpdateCompanyProfileDto } from "./company-profile.dto.js";

interface UploadedImageFile {
  readonly buffer: Buffer;
  readonly mimetype?: string;
  readonly originalname?: string;
  readonly size?: number;
}

@ApiTags("company-profile")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("company-profile")
export class CompanyProfileController {
  public constructor(
    @Inject(CompanyProfileService) private readonly profiles: CompanyProfileService,
  ) {}

  @ApiOperation({ summary: "Show the full Company profile (management view)" })
  @RequirePermissions("company_profile.manage")
  @Get()
  public profile(): Promise<CompanyProfile> {
    return this.profiles.profile();
  }

  @ApiOperation({ summary: "Update the Company profile" })
  @RequirePermissions("company_profile.manage")
  @Patch()
  public update(
    @Body() input: UpdateCompanyProfileDto,
    @Req() request: Request,
  ): Promise<CompanyProfile> {
    return this.profiles.updateProfile(input, correlationId(request));
  }

  @ApiOperation({ summary: "Upload or replace the Company logo (PNG/JPEG, max 2 MB)" })
  @ApiConsumes("multipart/form-data")
  @RequirePermissions("company_profile.manage")
  @Post("logo")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }))
  public uploadLogo(
    @UploadedFile() file: UploadedImageFile | undefined,
    @Req() request: Request,
  ): Promise<CompanyProfile> {
    if (file === undefined) {
      throw new ApplicationException(
        "logo_required",
        "A logo file is required under the 'file' field",
        400,
      );
    }
    return this.profiles.uploadLogo(file, correlationId(request));
  }

  @ApiOperation({ summary: "Remove the Company logo" })
  @RequirePermissions("company_profile.manage")
  @HttpCode(200)
  @Delete("logo")
  public removeLogo(@Req() request: Request): Promise<CompanyProfile> {
    return this.profiles.removeLogo(correlationId(request));
  }

  @ApiOperation({ summary: "Read the Company identity for portal/report display" })
  @Get("branding")
  public branding(): Promise<CompanyBranding> {
    return this.profiles.branding();
  }

  @ApiOperation({ summary: "Stream the Company logo bytes (authenticated, Company-scoped)" })
  @Get("logo")
  public async logo(@Res() response: Response): Promise<void> {
    const content = await this.profiles.logoContent();
    // The filename in the header is derived from the validated media type, not
    // from user input, so it cannot be used to inject header content.
    const fileName = content.mediaType === "image/png" ? "company-logo.png" : "company-logo.jpg";
    response.setHeader("Content-Type", content.mediaType);
    response.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(content.bytes);
  }
}

function correlationId(request: Request): string {
  return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
}
