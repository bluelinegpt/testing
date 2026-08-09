import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { Public } from "../authentication/authentication.decorators.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  EventRecoveryQueryDto,
  MarkConversationReadDto,
  MessageHistoryQueryDto,
  ResolveConversationDto,
  SendTextMessageDto,
  ConversationListQueryDto,
  CreateCustomerMessagingSessionDto,
} from "./communication.dto.js";
import { CommunicationService } from "./communication.service.js";

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

  @Post("conversations/:conversationId/read")
  public markRead(
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: MarkConversationReadDto,
  ) {
    return this.communication.markRead(conversationId, body);
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
}
