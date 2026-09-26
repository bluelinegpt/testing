import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import {
  closingTaskStatuses,
  closingWorkflowPriorities,
  closingWorkflowStatuses,
  closingWorkflowTypes,
  type ClosingTaskStatus,
  type ClosingWorkflowPriority,
  type ClosingWorkflowStatus,
  type ClosingWorkflowType,
} from "./accounting-closing.templates.js";

/**
 * Closing workflow request contracts.
 *
 * Every enumerated field is validated against the SAME constant the service and
 * the database CHECK use, imported rather than retyped. A DTO with its own copy
 * of the status list is a third definition that will eventually disagree with
 * the other two, and the disagreement shows up as a constraint violation the
 * caller cannot act on.
 */

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export class CreateClosingWorkflowDto {
  @IsIn(closingWorkflowTypes)
  public readonly workflowType!: ClosingWorkflowType;

  @IsUUID()
  public readonly fiscalYearId!: string;

  /**
   * Required for `monthly`, forbidden for `year_end`.
   *
   * Optional on the decorator because the rule is CONDITIONAL and a decorator
   * cannot express a condition that depends on another field's value. The
   * service rejects both mistakes explicitly, and the table's
   * `closing_workflows_period_shape_check` rejects them again.
   */
  @IsOptional()
  @IsUUID()
  public readonly accountingPeriodId?: string;

  @Matches(isoDate, { message: "dueDate must be YYYY-MM-DD" })
  public readonly dueDate!: string;

  @IsIn(closingWorkflowPriorities)
  public readonly priority!: ClosingWorkflowPriority;

  @IsUUID()
  public readonly assignedToAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly notes?: string;
}

export class ClosingWorkflowListQueryDto {
  @IsOptional()
  @IsIn(closingWorkflowTypes)
  public readonly workflowType?: ClosingWorkflowType;

  @IsOptional()
  @IsIn(closingWorkflowStatuses)
  public readonly status?: ClosingWorkflowStatus;

  @IsOptional()
  @IsIn(closingWorkflowPriorities)
  public readonly priority?: ClosingWorkflowPriority;

  @IsOptional()
  @IsUUID()
  public readonly fiscalYearId?: string;

  @IsOptional()
  @IsUUID()
  public readonly accountingPeriodId?: string;

  @IsOptional()
  @IsUUID()
  public readonly assignedToAccountId?: string;

  @IsOptional()
  @Matches(isoDate)
  public readonly dueFrom?: string;

  @IsOptional()
  @Matches(isoDate)
  public readonly dueTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly workflowNumber?: string;

  /** Closed and cancelled workflows are included unless this narrows them out. */
  @IsOptional()
  @IsIn(["active", "finished"])
  public readonly lifecycle?: "active" | "finished";

  @IsOptional()
  @IsIn(["createdAt", "dueDate", "priority", "status", "workflowNumber"])
  public readonly sortBy?: string;

  @IsOptional()
  @IsIn(["asc", "desc"])
  public readonly sortDirection?: "asc" | "desc";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly pageSize?: number;
}

/**
 * A checklist task carries STATUS, ASSIGNEE and NOTES, and nothing else.
 *
 * `closing_workflow_tasks` has no `due_date`, no `priority` and no
 * `completion_evidence` column. Due date and priority live on the workflow,
 * which is where this foundation put them. Evidence has no column at all:
 * `check_result` is reserved for the automated evaluation a later prompt adds,
 * and its null state must stay distinguishable from a failed check, so a
 * person's assertion cannot be written there.
 *
 * Those three fields are therefore NOT accepted rather than accepted and
 * discarded -- a request that appears to succeed while storing nothing is worse
 * than one that is refused. Adding them needs a migration this prompt forbids.
 */
export class UpdateClosingTaskDto {
  @IsOptional()
  @IsIn(closingTaskStatuses)
  public readonly status?: ClosingTaskStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly notes?: string;
}

export class AssignClosingTaskDto {
  /** Null clears the assignment; a uuid sets it. */
  @IsOptional()
  @IsUUID()
  public readonly assignedToAccountId?: string;
}

export class AddClosingCommentDto {
  /** Null targets the workflow as a whole rather than one task. */
  @IsOptional()
  @IsUUID()
  public readonly taskId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  public readonly body!: string;
}

export class AddClosingAttachmentDto {
  @IsOptional()
  @IsUUID()
  public readonly taskId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  public readonly fileName!: string;

  /** Where the bytes live. This module stores metadata only. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly storageKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  public readonly contentType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly byteSize?: number;
}

export class TransitionClosingWorkflowDto {
  @IsIn(closingWorkflowStatuses)
  public readonly toStatus!: ClosingWorkflowStatus;

  /**
   * Required by the service for every transition that records a judgement --
   * cancellation and any request for changes. Optional here because the rule
   * depends on the target status.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly reason?: string;

  /** Optimistic concurrency: the version the caller believes it is acting on. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly version!: number;
}

/**
 * Close a Monthly period.
 *
 * The reason is OPTIONAL here and mandatory for reopen: closing a period on
 * schedule is the expected outcome and needs no justification, while undoing
 * one is an exception that does.
 */
export class CloseClosingWorkflowDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly reason?: string;

  /** Optimistic concurrency: the version the caller believes it is closing. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly version!: number;
}

/**
 * Reopen a closed Monthly period.
 *
 * The reason is REQUIRED and the database agrees: `accounting_periods` will not
 * accept a `reopened` status without a non-blank `reopen_reason`. Reopening
 * undoes a control someone signed off, and an unexplained reversal of a
 * sign-off is not auditable.
 */
export class ReopenClosingWorkflowDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  public readonly reason!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly version!: number;
}

/**
 * Execute the Year-End financial close.
 *
 * The same shape as the Monthly close: the reason is optional, because closing
 * a year on schedule is the expected outcome. What makes this different is what
 * it does, not what it asks for.
 */
export class YearEndExecuteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public readonly reason?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly version!: number;
}

export class UpdateClosingWorkflowDto {
  @IsOptional()
  @Matches(isoDate, { message: "dueDate must be YYYY-MM-DD" })
  public readonly dueDate?: string;

  @IsOptional()
  @IsIn(closingWorkflowPriorities)
  public readonly priority?: ClosingWorkflowPriority;

  @IsOptional()
  @IsUUID()
  public readonly assignedToAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly notes?: string;
}
