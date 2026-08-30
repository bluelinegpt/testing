import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { AccountingClosingReadinessService } from "./accounting-closing-readiness.service.js";
import { AccountingClosingService } from "./accounting-closing.service.js";
import { AccountingYearEndService } from "./accounting-year-end.service.js";
// Imported as values, not types: `emitDecoratorMetadata` can only record a DTO
// class for the global ValidationPipe when the symbol survives to runtime, so
// these contracts are actually validated rather than accepted unchecked.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AddClosingAttachmentDto,
  AddClosingCommentDto,
  AssignClosingTaskDto,
  CloseClosingWorkflowDto,
  ClosingWorkflowListQueryDto,
  CreateClosingWorkflowDto,
  ReopenClosingWorkflowDto,
  TransitionClosingWorkflowDto,
  UpdateClosingTaskDto,
  UpdateClosingWorkflowDto,
  YearEndExecuteDto,
} from "./accounting-closing.dto.js";

/**
 * Accounting Period Closing workflow endpoints.
 *
 * Nothing here closes a period. Every route reads or advances the human process
 * that precedes a close; `accounting_periods.status` is untouched by all of
 * them, and no Journal, Event or balance is written.
 *
 * Permissions are declared per route AND asserted again in the service. The
 * decorator answers "may this identity reach the endpoint"; the service answers
 * "may this actor make this particular move", which depends on the workflow's
 * current state and on who submitted it. Only the second can enforce
 * maker-checker, so the first is a filter rather than the control.
 */
@ApiTags("accounting")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("accounting/closing-workflows")
export class AccountingClosingController {
  public constructor(
    @Inject(AccountingClosingService) private readonly closing: AccountingClosingService,
    @Inject(AccountingClosingReadinessService)
    private readonly readiness: AccountingClosingReadinessService,
    @Inject(AccountingYearEndService) private readonly yearEnd: AccountingYearEndService,
  ) {}

  /**
   * Run every automated check and store the result on each checklist task.
   *
   * A POST because it writes -- the stored results -- but it advances nothing:
   * no status moves, no period closes, no Journal is written, and every
   * financial source is read. Safe to rerun.
   */
  @Post(":id/readiness-check")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public runReadiness(@Param("id", ParseUUIDPipe) id: string) {
    return this.readiness.run(id);
  }

  /** The last stored results, without running anything. */
  @Get(":id/readiness")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public readinessState(@Param("id", ParseUUIDPipe) id: string) {
    return this.readiness.latest(id);
  }

  @Post()
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public create(
    @Body() input: CreateClosingWorkflowDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.closing.create(input, key);
  }

  @Get()
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public list(@Query() query: ClosingWorkflowListQueryDto) {
    return this.closing.list(query);
  }

  @Get(":id")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.closing.detail(id);
  }

  @Patch(":id")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateClosingWorkflowDto,
  ) {
    return this.closing.updateWorkflow(id, input);
  }

  @Patch(":id/tasks/:taskId")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public updateTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() input: UpdateClosingTaskDto,
  ) {
    return this.closing.updateTask(id, taskId, input);
  }

  @Post(":id/tasks/:taskId/assign")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public assignTask(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() input: AssignClosingTaskDto,
  ) {
    return this.closing.assignTask(id, taskId, input);
  }

  /** Append-only; a reader who can see the workflow may add to the record. */
  @Post(":id/comments")
  @RequireAnyPermission("accounting.view", "accounting.manage", "users_roles.manage")
  public addComment(@Param("id", ParseUUIDPipe) id: string, @Body() input: AddClosingCommentDto) {
    return this.closing.addComment(id, input);
  }

  /** Metadata only. This module stores no bytes and reads none. */
  @Post(":id/attachments")
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public addAttachment(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AddClosingAttachmentDto,
  ) {
    return this.closing.addAttachment(id, input);
  }

  /**
   * Advance the workflow.
   *
   * Deliberately open to `accounting.manage` OR `accounting.approve` at the
   * decorator: which of the two a given move actually needs depends on the
   * destination status, and the service decides that. A narrower decorator
   * would block preparers from submitting their own work for review.
   */
  /**
   * Execute the Monthly close: the accounting period and the workflow move to
   * `closed` in one transaction, or neither does.
   *
   * Separate from the generic transition endpoint on purpose. That one moves a
   * workflow status and nothing else; only this one is allowed to change what
   * may still be posted to a period.
   */
  @Post(":id/close")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public close(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CloseClosingWorkflowDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.closing.close(id, input, key);
  }

  /**
   * Execute the Year-End financial close.
   *
   * The only endpoint that posts a Closing Journal, carries balances into a new
   * fiscal year, creates that year and its periods, and locks the year behind
   * it -- all in one transaction that either completes or leaves nothing.
   */
  @Post(":id/year-end-execute")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public yearEndExecute(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: YearEndExecuteDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.yearEnd.execute(id, input, key);
  }

  /** Reopen a closed Monthly period. Appends to history; erases none of it. */
  @Post(":id/reopen")
  @RequireAnyPermission("accounting.approve", "users_roles.manage")
  public reopen(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ReopenClosingWorkflowDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.closing.reopen(id, input, key);
  }

  @Post(":id/transitions")
  @RequireAnyPermission("accounting.manage", "accounting.approve", "users_roles.manage")
  public transition(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: TransitionClosingWorkflowDto,
    @Headers("x-idempotency-key") key?: string,
  ) {
    return this.closing.transition(id, input, key);
  }
}
