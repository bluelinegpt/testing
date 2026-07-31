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
import {
  AccountingNoteDto,
  CreateOpeningBalanceDto,
  OpeningBalanceLineDto,
  OpeningBalanceListQueryDto,
  ReplaceOpeningBalanceLinesDto,
  ReverseOpeningBalanceDto,
  UpdateOpeningBalanceDto,
} from "./accounting.dto.js";
import { OpeningBalanceService } from "./opening-balance.service.js";

@ApiTags("accounting")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/accounting/opening-balances")
export class OpeningBalanceController {
  public constructor(
    @Inject(OpeningBalanceService) private readonly balances: OpeningBalanceService,
  ) {}

  @Get("summary")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public summary() {
    return this.balances.summary();
  }

  @Get()
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public list(@Query() query: OpeningBalanceListQueryDto) {
    return this.balances.list(query);
  }

  @Get(":batchId")
  @RequireAnyPermission("accounting.view", "users_roles.manage")
  public detail(@Param("batchId", new ParseUUIDPipe()) id: string) {
    return this.balances.detail(id);
  }

  @Post()
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public create(
    @Body() input: CreateOpeningBalanceDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.create(input, key);
  }

  @Patch(":batchId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public update(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Body() input: UpdateOpeningBalanceDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.updateHeader(id, input, key);
  }

  @Post(":batchId/lines")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public addLine(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Body() line: OpeningBalanceLineDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.addLine(id, line, key);
  }

  @Patch(":batchId/lines/:lineId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public updateLine(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Body() line: OpeningBalanceLineDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.updateLine(id, lineId, line, key);
  }

  @Delete(":batchId/lines/:lineId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public removeLine(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.removeLine(id, lineId, key);
  }

  @Put(":batchId/lines")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public replaceLines(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Body() input: ReplaceOpeningBalanceLinesDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.replaceLines(id, input.lines, key);
  }

  @Post(":batchId/validate")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public validate(@Param("batchId", new ParseUUIDPipe()) id: string) {
    return this.balances.validate(id);
  }

  @Post(":batchId/approve")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public approve(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingNoteDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.approve(id, input.note, key);
  }

  @Post(":batchId/post")
  @RequireAnyPermission("accounting.post", "users_roles.manage")
  public post(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Body() input: AccountingNoteDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.post(id, input.note, key);
  }

  @Post(":batchId/reverse")
  @RequireAnyPermission("accounting.reverse", "users_roles.manage")
  public reverse(
    @Param("batchId", new ParseUUIDPipe()) id: string,
    @Body() input: ReverseOpeningBalanceDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.balances.reverse(id, input, key);
  }
}
