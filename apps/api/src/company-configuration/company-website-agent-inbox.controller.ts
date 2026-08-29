import { Controller, Get, Inject, Param, ParseUUIDPipe } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
import { CompanyWebsiteAgentInboxService } from "./company-website-agent-inbox.service.js";

@ApiTags("company website agent conversations")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("configuration/website-agent/conversations")
export class CompanyWebsiteAgentInboxController {
  public constructor(
    @Inject(CompanyWebsiteAgentInboxService)
    private readonly conversations: CompanyWebsiteAgentInboxService,
  ) {}

  @ApiOperation({ summary: "List this Company's public website AI conversations" })
  @Get()
  public list() {
    return this.conversations.list();
  }

  @ApiOperation({ summary: "Read one full Company-scoped public website AI conversation" })
  @Get(":conversationId")
  public get(@Param("conversationId", new ParseUUIDPipe()) conversationId: string) {
    return this.conversations.get(conversationId);
  }
}
