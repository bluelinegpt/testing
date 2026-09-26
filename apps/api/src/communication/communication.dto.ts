import { Type } from "class-transformer";
import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
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

  @IsOptional()
  @IsIn(["normal", "high", "urgent"])
  public priority?: string;
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

/**
 * Multipart form fields alongside the audio file itself (see
 * `SendVoiceMessageDto` on the multipart route) — every field arrives on
 * `request.body` as a string, so `durationSeconds` is coerced via `@Type`
 * before `class-validator` runs.
 */
export class SendVoiceMessageDto {
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

  /** Client-reported recording length. Re-validated server-side against the
   *  same 5-minute ceiling the database enforces — never trusted alone. */
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(300)
  public durationSeconds!: number;
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
