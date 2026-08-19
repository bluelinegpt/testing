import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CreateAgentConversationDto {
  @IsOptional() @IsIn(["en", "ar"]) readonly language?: "en" | "ar";
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) readonly visitorId?: string;
}

export class SendAgentMessageDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1200) readonly message!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly inboundMessageId?: string;
  @IsOptional() @IsIn(["en", "ar"]) readonly language?: "en" | "ar";
}

export class SimulateWhatsAppMessageDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(40) readonly sender!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1200) readonly message!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) readonly inboundMessageId!: string;
  @IsOptional() @IsIn(["en", "ar"]) readonly language?: "en" | "ar";
}

export class AgentKnowledgeDto {
  @IsIn(["en", "ar"]) readonly language!: "en" | "ar";
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) readonly title!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(4000) readonly content!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) readonly category!: string;
  @IsOptional() @IsIn(["public", "delivery_company", "trader", "customer", "all"]) readonly audience?: "public" | "delivery_company" | "trader" | "customer" | "all";
  @IsOptional() @IsIn(["live", "planned", "on_hold", "future", "internal_only", "informational"]) readonly featureStatus?: "live" | "planned" | "on_hold" | "future" | "internal_only" | "informational";
  @IsOptional() @IsIn(["public_agent", "internal_only"]) readonly visibility?: "public_agent" | "internal_only";
  @IsIn(["draft", "published", "archived"]) readonly status!: "draft" | "published" | "archived";
  @IsOptional() readonly sortOrder?: number;
}

export class AgentSettingsDto {
  @IsIn([true, false]) readonly agentEnabled!: boolean;
  @IsIn([true, false]) readonly websiteChatEnabled!: boolean;
  @IsIn([true, false]) readonly whatsappAgentEnabled!: boolean;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) readonly assistantDisplayName!: string;
  @IsIn(["en", "ar"]) readonly defaultLanguage!: "en" | "ar";
  @IsIn([true, false]) readonly humanHandoffEnabled!: boolean;
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(600) readonly generalFallbackMessage!: string;
  @IsOptional() @IsIn(["meta_cloud", "sandbox", "disabled"]) readonly whatsappProvider?: "meta_cloud" | "sandbox" | "disabled";
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) readonly whatsappBusinessNumber?: string;
  @IsOptional() @IsIn([true, false]) readonly whatsappPublicCtaEnabled?: boolean;
}

export class HandoffStatusDto {
  @IsIn(["new", "reviewing", "contacted", "resolved", "closed"])
  readonly status!: "new" | "reviewing" | "contacted" | "resolved" | "closed";
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) readonly notes?: string;
}

export class AgentConversationReviewDto {
  @IsIn(["new", "open", "in_progress", "waiting_for_customer", "follow_up", "resolved", "closed"])
  readonly status!: "new" | "open" | "in_progress" | "waiting_for_customer" | "follow_up" | "resolved" | "closed";
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) readonly comment?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly action?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) readonly assignedToAccountId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) readonly classification?: string;
}

export class AgentConversationCommentDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(2000) readonly comment!: string;
}

export class PlatformWhatsAppReplyDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1200) readonly message!: string;
}

export class ConversationModeDto {
  @IsIn(["ai_active", "human_active", "paused", "ai_resume"]) readonly mode!: "ai_active" | "human_active" | "paused" | "ai_resume";
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) readonly note?: string;
}

export class WhatsAppSettingsDto {
  @IsIn([true, false]) readonly whatsappAgentEnabled!: boolean;
  @IsIn([true, false]) readonly whatsappPublicCtaEnabled!: boolean;
  @IsIn(["meta_cloud", "sandbox", "disabled"]) readonly whatsappProvider!: "meta_cloud" | "sandbox" | "disabled";
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(40) readonly whatsappBusinessNumber!: string;
}

export class WhatsAppWebhookQueryDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly "hub.mode"?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) readonly "hub.verify_token"?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) readonly "hub.challenge"?: string;
}

export class MetaWhatsAppWebhookDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) readonly object?: string;
}
