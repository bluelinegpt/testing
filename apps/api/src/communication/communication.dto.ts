import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";

export class ResolveConversationDto {
  @IsIn(["order", "general_support"])
  public conversationType: "order" | "general_support" = "order";

  @IsOptional()
  @IsUUID()
  public orderId?: string;

  @IsOptional()
  @IsIn(["trader", "driver", "customer"])
  public participantContextType?: "trader" | "driver" | "customer";

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public subject?: string;
}

export class ConversationListQueryDto {
  @IsOptional()
  @IsString()
  public cursor?: string;

  @IsOptional()
  @IsString()
  public limit?: string;

  @IsOptional()
  @IsIn(["active", "waiting_for_office", "waiting_for_user", "resolved", "reopened"])
  public status?: string;

  @IsOptional()
  @IsIn(["trader", "driver", "customer"])
  public participantContextType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @IsOptional()
  @IsIn(["true", "false"])
  public unreadOnly?: string;
}

export class MessageHistoryQueryDto {
  @IsOptional()
  @IsString()
  public before?: string;

  @IsOptional()
  @IsString()
  public after?: string;

  @IsOptional()
  @IsString()
  public limit?: string;
}

export class SendTextMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  public text!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  public clientMessageId!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  public idempotencyKey!: string;

  @IsOptional()
  @IsISO8601()
  public originalClientTime?: string;
}

export class MarkConversationReadDto {
  @IsUUID()
  public throughMessageId!: string;
}

export class EventRecoveryQueryDto {
  @IsOptional()
  @IsString()
  public after?: string;

  @IsOptional()
  @IsString()
  public limit?: string;
}

export class AssignConversationDto {
  @IsOptional()
  @IsUUID()
  public operatorAccountId?: string;
}

export class SetConversationPriorityDto {
  @IsIn(["normal", "high", "urgent"])
  public priority!: "normal" | "high" | "urgent";
}

export class CreateCustomerMessagingSessionDto {
  @IsString()
  @MinLength(43)
  @MaxLength(43)
  public trackingToken!: string;
}

export class CustomerSessionTokenDto {
  @IsString()
  @MinLength(43)
  @MaxLength(43)
  public customerMessagingToken!: string;
}
