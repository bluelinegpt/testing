import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import type {
  AccountingNoteDto,
  CancelJournalDto,
  CreateJournalDto,
  JournalLineDto,
  JournalListQueryDto,
  ReplaceJournalLinesDto,
  ReverseJournalDto,
  UpdateJournalDto,
} from "./accounting.dto.js";
import { ManualJournalService } from "./manual-journal.service.js";

@ApiTags("accounting")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/journals")
export class ManualJournalController {
  public constructor(
    @Inject(ManualJournalService) private readonly journals: ManualJournalService,
  ) {}

  @Get("summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public summary() {
    return this.journals.summary();
  }

  @Get()
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public list(@Query() query: JournalListQueryDto) {
    return this.journals.list(query);
  }

  @Get(":journalId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public detail(@Param("journalId", new ParseUUIDPipe()) journalId: string) {
    return this.journals.detail(journalId);
  }

  @Post()
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public create(@Body() input: CreateJournalDto, @Headers("x-idempotency-key") key?: string) {
    return this.journals.create(input, key);
  }

  @Patch(":journalId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public update(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() input: UpdateJournalDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.updateHeader(id, input, key);
  }

  @Post(":journalId/lines")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public addLine(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() line: JournalLineDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.addLine(id, line, key);
  }

  @Patch(":journalId/lines/:lineId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public updateLine(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Body() line: JournalLineDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.updateLine(id, lineId, line, key);
  }

  @Delete(":journalId/lines/:lineId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public removeLine(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.removeLine(id, lineId, key);
  }

  @Put(":journalId/lines")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public replaceLines(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() input: ReplaceJournalLinesDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.replaceLines(id, input, key);
  }

  @Post(":journalId/validate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public validate(@Param("journalId", new ParseUUIDPipe()) id: string) {
    return this.journals.validate(id);
  }

  @Post(":journalId/approve")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public approve(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingNoteDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.approve(id, input.note, key);
  }

  @Post(":journalId/post")
  @RequireAnyPermission("accounting.post", "users_roles.manage")
  public post(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingNoteDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.post(id, input.note, key);
  }

  @Post(":journalId/cancel")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public cancel(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() input: CancelJournalDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.cancel(id, input.reason, key);
  }

  @Post(":journalId/reverse")
  @RequireAnyPermission("accounting.reverse", "users_roles.manage")
  public reverse(
    @Param("journalId", new ParseUUIDPipe()) id: string,
    @Body() input: ReverseJournalDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.journals.reverse(id, input, key);
  }
}
