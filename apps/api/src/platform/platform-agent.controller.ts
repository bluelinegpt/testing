import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { AgentAvatarSettingsDto, AgentConversationCommentDto, AgentConversationReviewDto, AgentKnowledgeDto, AgentSettingsDto, ConversationModeDto, HandoffStatusDto, PlatformWhatsAppReplyDto } from "../agent/agent.dto.js";
import { AgentService } from "../agent/agent.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { RequirePlatformPermissions } from "./platform-authorization.js";

const READ = "platform.agent.read";
const MANAGE = "platform.agent.manage";

@Controller("platform/agent")
export class PlatformAgentController {
  public constructor(
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(IdentityContextAccessor) private readonly identity: IdentityContextAccessor,
  ) {}

  private actor() {
    return this.identity.current().identityId;
  }

  @RequirePlatformPermissions(READ) @Get("conversations")
  public conversations(@Query() query: Record<string, string | undefined>) {
    return this.agent.adminConversations(query);
  }

  @RequirePlatformPermissions(READ) @Get("assignees")
  public assignees() {
    return this.agent.platformAssignees();
  }

  @RequirePlatformPermissions(READ) @Get("conversations/:id")
  public conversation(@Param("id") id: string) {
    return this.agent.adminConversation(id);
  }

  @RequirePlatformPermissions(MANAGE) @Patch("conversations/:id/review")
  public conversationReview(@Param("id") id: string, @Body() body: AgentConversationReviewDto) {
    return this.agent.updateConversationReview(id, body, this.actor());
  }

  @RequirePlatformPermissions(MANAGE) @Post("conversations/:id/comments")
  public conversationComment(@Param("id") id: string, @Body() body: AgentConversationCommentDto) {
    return this.agent.addConversationComment(id, body.comment, this.actor());
  }

  @RequirePlatformPermissions("platform.agent.whatsapp.reply") @Post("conversations/:id/whatsapp/reply")
  public whatsAppReply(@Param("id") id: string, @Body() body: PlatformWhatsAppReplyDto) {
    return this.agent.replyToWhatsAppConversation(id, body.message, this.actor());
  }

  @RequirePlatformPermissions(MANAGE) @Post("conversations/:id/website/reply")
  public websiteReply(@Param("id") id: string, @Body() body: PlatformWhatsAppReplyDto) {
    return this.agent.replyToWebsiteConversation(id, body.message, this.actor());
  }

  @RequirePlatformPermissions("platform.agent.whatsapp.takeover") @Patch("conversations/:id/mode")
  public conversationMode(@Param("id") id: string, @Body() body: ConversationModeDto) {
    return this.agent.setConversationMode(id, body.mode, this.actor(), body.note);
  }

  @RequirePlatformPermissions(MANAGE) @Patch("conversations/:id/hide")
  public hideConversation(@Param("id") id: string) {
    return this.agent.hideConversation(id, this.actor());
  }

  @RequirePlatformPermissions(MANAGE) @Patch("conversations/:id/unhide")
  public unhideConversation(@Param("id") id: string) {
    return this.agent.unhideConversation(id, this.actor());
  }

  @RequirePlatformPermissions(MANAGE) @Patch("conversations/:id/delete")
  public deleteConversation(@Param("id") id: string) {
    return this.agent.deleteConversation(id, this.actor());
  }

  @RequirePlatformPermissions(READ) @Get("handoffs")
  public handoffs() {
    return this.agent.handoffs();
  }

  @RequirePlatformPermissions(MANAGE) @Patch("handoffs/:id/status")
  public handoffStatus(@Param("id") id: string, @Body() body: HandoffStatusDto) {
    return this.agent.updateHandoffStatus(id, body.status, body.notes, this.actor());
  }

  @RequirePlatformPermissions(READ) @Get("knowledge")
  public knowledge() {
    return this.agent.knowledge();
  }

  @RequirePlatformPermissions(MANAGE) @Post("knowledge")
  public createKnowledge(@Body() body: AgentKnowledgeDto) {
    return this.agent.saveKnowledge(body, this.actor());
  }

  @RequirePlatformPermissions(MANAGE) @Patch("knowledge/:id")
  public updateKnowledge(@Param("id") id: string, @Body() body: AgentKnowledgeDto) {
    return this.agent.saveKnowledge(body, this.actor(), id);
  }

  @RequirePlatformPermissions(READ) @Get("settings")
  public settings() {
    return this.agent.settings();
  }

  @RequirePlatformPermissions(MANAGE) @Patch("settings")
  public updateSettings(@Body() body: AgentSettingsDto) {
    return this.agent.updateSettings(body, this.actor());
  }

  @RequirePlatformPermissions(MANAGE) @Patch("avatar/settings")
  public updateAvatarSettings(@Body() body: AgentAvatarSettingsDto) {
    return this.agent.updateAvatarSettings(body, this.actor());
  }
}
