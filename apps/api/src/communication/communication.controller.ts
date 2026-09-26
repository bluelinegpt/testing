import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { Public } from "../authentication/authentication.decorators.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AssignConversationDto,
  EventRecoveryQueryDto,
  MarkConversationReadDto,
  MessageHistoryQueryDto,
  ResolveConversationDto,
  SendTextMessageDto,
  SendVoiceMessageDto,
  SetConversationPriorityDto,
  ConversationListQueryDto,
  CreateCustomerMessagingSessionDto,
} from "./communication.dto.js";
import { CommunicationService, type UploadedVoiceFile } from "./communication.service.js";
import { VOICE_MAX_SIZE_BYTES } from "./voice-media.rules.js";

@ApiBearerAuth()
@ApiTags("communication")
@RequireIdentityKinds("company_user", "trader", "driver")
@Controller("communication")
export class CommunicationController {
  public constructor(
    @Inject(CommunicationService) private readonly communication: CommunicationService,
  ) {}

  @Post("conversations/resolve")
  public resolve(@Body() body: ResolveConversationDto) {
    return this.communication.resolveConversation(body);
  }

  @Get("conversations")
  public list(@Query() query: ConversationListQueryDto) {
    return this.communication.listConversations(query);
  }

  @Get("conversations/:conversationId/messages")
  public messages(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Query() query: MessageHistoryQueryDto,
  ) {
    return this.communication.getMessages(conversationId, query);
  }

  @Post("conversations/:conversationId/messages")
  public send(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: SendTextMessageDto,
  ) {
    return this.communication.sendTextMessage(conversationId, body);
  }

  @ApiConsumes("multipart/form-data")
  @Post("conversations/:conversationId/voice-messages")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: VOICE_MAX_SIZE_BYTES, files: 1 } }),
  )
  public sendVoice(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: SendVoiceMessageDto,
    @UploadedFile() file: UploadedVoiceFile | undefined,
  ) {
    return this.communication.sendVoiceMessage(
      conversationId,
      body,
      file ?? { buffer: Buffer.alloc(0) },
    );
  }

  @Get("messages/:messageId/media")
  public async media(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Res() response: Response,
  ): Promise<void> {
    const media = await this.communication.getMessageMedia(messageId);
    this.sendMedia(response, media);
  }

  @Post("conversations/:conversationId/read")
  public markRead(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: MarkConversationReadDto,
  ) {
    return this.communication.markRead(conversationId, body);
  }

  @Post("conversations/:conversationId/resolve")
  public resolveStatus(@Param("conversationId", ParseUUIDPipe) conversationId: string) {
    return this.communication.markConversationResolved(conversationId);
  }

  @Post("conversations/:conversationId/reopen")
  public reopen(@Param("conversationId", ParseUUIDPipe) conversationId: string) {
    return this.communication.reopenConversation(conversationId);
  }

  @Patch("conversations/:conversationId/priority")
  public setPriority(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: SetConversationPriorityDto,
  ) {
    return this.communication.setConversationPriority(conversationId, body);
  }

  @Patch("conversations/:conversationId/assign")
  public assign(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: AssignConversationDto,
  ) {
    return this.communication.assignConversation(conversationId, body);
  }

  @Get("messages/unread-count")
  public unread() {
    return this.communication.unreadSummary();
  }

  @Get("realtime/events")
  public recover(@Query() query: EventRecoveryQueryDto) {
    return this.communication.recoverEvents(query);
  }

  @Public()
  @Post("customer/sessions")
  public customerSession(@Body() body: CreateCustomerMessagingSessionDto) {
    return this.communication.createCustomerMessagingSession(body);
  }

  @Public()
  @Post("customer/messaging/conversation")
  public customerConversation(@Headers("x-customer-messaging-token") token: string | undefined) {
    return this.communication.customerResolveConversation(token ?? "");
  }

  @Public()
  @Get("customer/messaging/messages")
  public customerMessages(
    @Headers("x-customer-messaging-token") token: string | undefined,
    @Query() query: MessageHistoryQueryDto,
  ) {
    return this.communication.customerMessages(token ?? "", query);
  }

  @Public()
  @Post("customer/messaging/messages")
  public customerSend(
    @Headers("x-customer-messaging-token") token: string | undefined,
    @Body() body: SendTextMessageDto,
  ) {
    return this.communication.customerSendText(token ?? "", body);
  }

  @Public()
  @ApiConsumes("multipart/form-data")
  @Post("customer/messaging/voice-messages")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: VOICE_MAX_SIZE_BYTES, files: 1 } }),
  )
  public customerSendVoice(
    @Headers("x-customer-messaging-token") token: string | undefined,
    @Body() body: SendVoiceMessageDto,
    @UploadedFile() file: UploadedVoiceFile | undefined,
  ) {
    return this.communication.customerSendVoiceMessage(
      token ?? "",
      body,
      file ?? { buffer: Buffer.alloc(0) },
    );
  }

  @Public()
  @Get("customer/messaging/messages/:messageId/media")
  public async customerMedia(
    @Headers("x-customer-messaging-token") token: string | undefined,
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Res() response: Response,
  ): Promise<void> {
    const media = await this.communication.customerMessageMedia(token ?? "", messageId);
    this.sendMedia(response, media);
  }

  @Public()
  @Post("customer/messaging/read")
  public customerRead(
    @Headers("x-customer-messaging-token") token: string | undefined,
    @Body() body: MarkConversationReadDto,
  ) {
    return this.communication.customerMarkRead(token ?? "", body);
  }

  @Public()
  @Get("customer/messaging/unread-count")
  public customerUnread(@Headers("x-customer-messaging-token") token: string | undefined) {
    return this.communication.customerUnread(token ?? "");
  }

  @Public()
  @Get("customer/messaging/realtime/events")
  public customerRecover(
    @Headers("x-customer-messaging-token") token: string | undefined,
    @Query() query: EventRecoveryQueryDto,
  ) {
    return this.communication.customerRecoverEvents(token ?? "", query);
  }

  /** Bytes only — never a redirect to a storage URL, so no permanent public
   *  link to a voice message ever exists. Headers are derived entirely from
   *  server-validated data, never from client input. */
  private sendMedia(
    response: Response,
    media: { readonly content: Uint8Array; readonly mimeType: string; readonly sizeBytes: number },
  ): void {
    response.setHeader("Content-Type", media.mimeType);
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(Buffer.from(media.content));
  }
}
