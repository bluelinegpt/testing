import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingClosingReadinessService } from "./accounting-closing-readiness.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import {
  canTransition,
  closingTemplateFor,
  type ClosingWorkflowStatus,
} from "./accounting-closing.templates.js";
import type {
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
} from "./accounting-closing.dto.js";

/**
 * The human process that precedes closing an accounting period.
 *
 * ===========================================================================
 * IT CLOSES NOTHING
 * ===========================================================================
 *
 * No method here touches `accounting_periods.status`, writes a Journal, moves a
 * balance, creates a fiscal year or locks anything. The workflow records who
 * checked what, who reviewed it, who approved it and when. Executing the close
 * is a separate, later decision, and the two transitions that would coincide
 * with it -- `approved -> closed` and `closed -> reopened` -- are refused here
 * rather than quietly moving a status that would then claim work nobody did.
 *
 * ===========================================================================
 * THE TRANSITION MAP IS NOT RESTATED
 * ===========================================================================
 *
 * Legality comes from `canTransition` in accounting-closing.templates.ts, which
 * is the single description of the state machine. This service adds only what a
 * data table cannot express: WHO may make each move, and what each move must
 * stamp. Re-encoding the map as `if` statements here would create a second
 * answer to "is this move legal", and the two would eventually disagree.
 *
 * ===========================================================================
 * MAKER-CHECKER IS ASSERTED, NOT ASSUMED
 * ===========================================================================
 *
 * The database already forbids the approver from being the submitter. That
 * constraint is the backstop, not the control: it produces a raw violation the
 * caller cannot act on. The checks here reject the same thing with an error
 * that explains it, and add the rule the schema cannot -- that the person who
 * CREATED the workflow may not approve it either, where another authorised
 * approver exists to do it instead.
 */

const workflowSelect = sql`
  w.id, w.workflow_number as "workflowNumber", w.workflow_type as "workflowType",
  w.fiscal_year_id as "fiscalYearId", w.accounting_period_id as "accountingPeriodId",
  w.status, w.priority, w.due_date::text as "dueDate",
  w.assigned_to_account_id as "assignedToAccountId",
  assignee.username as "assignedToUsername",
  -- The three maker-checker identities by NAME as well as id. A screen that
  -- had only the ids could show nothing a person recognises, and rendering a
  -- raw account uuid to a user is not an identity.
  w.submitted_by_account_id as "submittedByAccountId", w.submitted_at as "submittedAt",
  submitter.username as "submittedByUsername",
  w.reviewed_by_account_id as "reviewedByAccountId", w.reviewed_at as "reviewedAt",
  reviewer.username as "reviewedByUsername",
  w.approved_by_account_id as "approvedByAccountId", w.approved_at as "approvedAt",
  approver.username as "approvedByUsername",
  w.closed_at as "closedAt", w.cancelled_at as "cancelledAt",
  w.cancellation_reason as "cancellationReason", w.notes,
  w.created_by_account_id as "createdByAccountId", creator.username as "createdByUsername",
  w.created_at as "createdAt", w.updated_at as "updatedAt", w.version,
  y.fiscal_year_code as "fiscalYearCode", p.period_code as "periodCode", p.name as "periodName"
`;

const workflowJoins = sql`
  from closing_workflows w
  left join accounts assignee
    on assignee.id = w.assigned_to_account_id and assignee.company_id = w.company_id
  left join accounts creator
    on creator.id = w.created_by_account_id and creator.company_id = w.company_id
  left join accounts submitter
    on submitter.id = w.submitted_by_account_id and submitter.company_id = w.company_id
  left join accounts reviewer
    on reviewer.id = w.reviewed_by_account_id and reviewer.company_id = w.company_id
  left join accounts approver
    on approver.id = w.approved_by_account_id and approver.company_id = w.company_id
  left join fiscal_years y on y.id = w.fiscal_year_id and y.company_id = w.company_id
  left join accounting_periods p
    on p.id = w.accounting_period_id and p.company_id = w.company_id
`;

interface WorkflowRow {
  readonly accountingPeriodId: string | null;
  readonly createdByAccountId: string;
  readonly fiscalYearId: string;
  readonly id: string;
  readonly status: ClosingWorkflowStatus;
  readonly submittedByAccountId: string | null;
  readonly version: number;
  readonly workflowNumber: string;
  readonly workflowType: "monthly" | "year_end";
}

/** Which permission each destination status demands. */
const transitionPermission: Readonly<Record<ClosingWorkflowStatus, string>> = {
  approved: "accounting.approve",
  blocked: "accounting.manage",
  cancelled: "accounting.manage",
  changes_requested: "accounting.approve",
  closed: "accounting.approve",
  draft: "accounting.manage",
  in_progress: "accounting.manage",
  ready_for_approval: "accounting.approve",
  ready_for_review: "accounting.manage",
  reopened: "accounting.approve",
  under_review: "accounting.approve",
};

/** Moves that must say why. A judgement with no reason is not a judgement. */
const reasonRequired: readonly ClosingWorkflowStatus[] = ["cancelled", "changes_requested"];

/**
 * Transitions that would coincide with actually closing or reopening a period.
 * Refused until that execution exists, so a workflow can never read `closed`
 * while the period it names is still open.
 */
const executionStatuses: readonly ClosingWorkflowStatus[] = ["closed", "reopened"];

@Injectable()
export class AccountingClosingService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(AccountingClosingReadinessService)
    private readonly readiness: AccountingClosingReadinessService,
  ) {}

  /**
   * Create a workflow and populate its checklist from the template.
   *
   * The tasks are written as a SNAPSHOT: `task_key` for identity and
   * `task_label_snapshot` for wording, so renaming a template item later does
   * not rewrite what a completed checklist said at the time.
   */
  public async create(input: CreateClosingWorkflowDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.manage");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.closing-workflow.create",
        payload: { ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;

      // The shape rule is conditional on the type, which a DTO decorator cannot
      // express; rejected here with a message rather than left to the CHECK.
      if (input.workflowType === "monthly" && input.accountingPeriodId === undefined) {
        this.conflict("accounting_closing_period_required", HttpStatus.BAD_REQUEST);
      }
      if (input.workflowType === "year_end" && input.accountingPeriodId !== undefined) {
        this.conflict("accounting_closing_period_not_allowed", HttpStatus.BAD_REQUEST);
      }

      const fiscalYear = await sql<{ id: string }>`
        select id from fiscal_years
         where id = ${input.fiscalYearId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      if (fiscalYear.rows[0] === undefined) {
        this.conflict("accounting_closing_fiscal_year_not_found", HttpStatus.NOT_FOUND);
      }
      if (input.accountingPeriodId !== undefined) {
        // Company AND fiscal year: a period from another year would produce a
        // workflow whose period and year describe different things.
        const period = await sql<{ id: string }>`
          select id from accounting_periods
           where id = ${input.accountingPeriodId}::uuid and company_id = ${companyId}::uuid
             and fiscal_year_id = ${input.fiscalYearId}::uuid
        `.execute(transaction);
        if (period.rows[0] === undefined) {
          this.conflict("accounting_closing_period_not_found", HttpStatus.NOT_FOUND);
        }
      }
      await this.assertCompanyAccount(transaction, input.assignedToAccountId);

      // Checked here for a friendly answer; the partial unique index is the
      // guarantee. Two callers racing both reach the index, and one loses.
      const duplicate = await sql<{ workflowNumber: string }>`
        select workflow_number as "workflowNumber" from closing_workflows
         where company_id = ${companyId}::uuid
           and fiscal_year_id = ${input.fiscalYearId}::uuid
           and coalesce(accounting_period_id, '00000000-0000-0000-0000-000000000000'::uuid)
               = coalesce(${input.accountingPeriodId ?? null}::uuid,
                          '00000000-0000-0000-0000-000000000000'::uuid)
           and workflow_type = ${input.workflowType}
           and status not in ('closed', 'cancelled')
      `.execute(transaction);
      if (duplicate.rows[0] !== undefined) {
        throw new ApplicationException(
          "accounting_closing_workflow_already_active",
          "An active closing workflow already exists for this period and type",
          HttpStatus.CONFLICT,
          [`Existing workflow: ${duplicate.rows[0].workflowNumber}`],
        );
      }

      const workflowNumber = await this.nextWorkflowNumber(transaction, companyId);
      const created = await sql<{ correlationId: string; id: string }>`
        insert into closing_workflows (
          company_id, workflow_number, workflow_type, fiscal_year_id, accounting_period_id,
          status, priority, due_date, assigned_to_account_id, notes, created_by_account_id
        ) values (
          ${companyId}::uuid, ${workflowNumber}, ${input.workflowType},
          ${input.fiscalYearId}::uuid, ${input.accountingPeriodId ?? null}::uuid,
          'draft', ${input.priority}, ${input.dueDate}::date,
          ${input.assignedToAccountId}::uuid, ${input.notes?.trim() || null}, ${actorId}::uuid
        )
        returning id, gen_random_uuid()::text as "correlationId"
      `.execute(transaction);
      const workflowId = created.rows[0]!.id;
      const correlationId = created.rows[0]!.correlationId;

      const template = closingTemplateFor(input.workflowType);
      for (const task of template) {
        await sql`
          insert into closing_workflow_tasks (
            company_id, closing_workflow_id, task_key, task_label_snapshot,
            sequence, is_mandatory, status
          ) values (
            ${companyId}::uuid, ${workflowId}::uuid, ${task.key}, ${task.label},
            ${task.sequence}, ${task.mandatory}, 'pending'
          )
        `.execute(transaction);
      }

      // The opening entry in the immutable history: a workflow that appears at
      // `draft` with no transition row would have no record of its own birth.
      await this.recordTransition(transaction, {
        correlationId,
        fromStatus: null,
        reason: null,
        toStatus: "draft",
        workflowId,
      });

      const response = {
        id: workflowId,
        status: "draft",
        taskCount: template.length,
        workflowNumber,
        workflowType: input.workflowType,
      };
      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.created",
        after: response,
        correlationId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
      if (idempotencyKey !== undefined) {
        await this.support.completeIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.closing-workflow.create",
          resourceId: workflowId,
          resourceType: "closing_workflow",
          responseBody: response,
        });
      }
      return response;
    });
  }

  /** Server-side filtered, sorted and paginated list. */
  public async list(query: ClosingWorkflowListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    // Chosen from a closed list validated by the DTO, so the resolved
    // expression is a literal and never caller text.
    const sortColumns: Readonly<Record<string, string>> = {
      createdAt: "w.created_at",
      dueDate: "w.due_date",
      priority: "w.priority",
      status: "w.status",
      workflowNumber: "w.workflow_number",
    };
    const sort = sortColumns[query.sortBy ?? "dueDate"] ?? "w.due_date";
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
    const result = await sql<Record<string, unknown>>`
      select ${workflowSelect}, count(*) over()::int as "totalCount",
             -- Checklist progress, so a list row can show it without the
             -- client fetching every workflow's tasks. Counted in SQL rather
             -- than derived client-side: a screen that computed its own
             -- progress would eventually disagree with the detail page.
             (select count(*)::int from closing_workflow_tasks ct
               where ct.company_id = w.company_id and ct.closing_workflow_id = w.id)
               as "taskCount",
             (select count(*)::int from closing_workflow_tasks ct
               where ct.company_id = w.company_id and ct.closing_workflow_id = w.id
                 and ct.status in ('completed', 'not_applicable'))
               as "completedTaskCount"
      ${workflowJoins}
       where w.company_id = ${companyId}::uuid
         and (${query.workflowType ?? null}::text is null
              or w.workflow_type = ${query.workflowType ?? null})
         and (${query.status ?? null}::text is null or w.status = ${query.status ?? null})
         and (${query.priority ?? null}::text is null or w.priority = ${query.priority ?? null})
         and (${query.fiscalYearId ?? null}::uuid is null
              or w.fiscal_year_id = ${query.fiscalYearId ?? null}::uuid)
         and (${query.accountingPeriodId ?? null}::uuid is null
              or w.accounting_period_id = ${query.accountingPeriodId ?? null}::uuid)
         and (${query.assignedToAccountId ?? null}::uuid is null
              or w.assigned_to_account_id = ${query.assignedToAccountId ?? null}::uuid)
         and (${query.dueFrom ?? null}::date is null or w.due_date >= ${query.dueFrom ?? null}::date)
         and (${query.dueTo ?? null}::date is null or w.due_date <= ${query.dueTo ?? null}::date)
         and (${query.workflowNumber ?? null}::text is null
              or w.workflow_number ilike '%' || ${query.workflowNumber ?? null} || '%')
         and (${query.lifecycle ?? null}::text is null
              or (${query.lifecycle ?? null} = 'active'
                  and w.status not in ('closed', 'cancelled'))
              or (${query.lifecycle ?? null} = 'finished'
                  and w.status in ('closed', 'cancelled')))
       order by ${sql.raw(sort)} ${sql.raw(direction)} nulls last, w.created_at desc, w.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    const totalCount = Number(result.rows[0]?.totalCount ?? 0);
    return { items: result.rows, page, pageSize, totalCount };
  }

  /** One workflow with its checklist, comments, attachments, reviews and history. */
  public async detail(workflowId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const workflow = await sql<Record<string, unknown>>`
      select ${workflowSelect}
      ${workflowJoins}
       where w.company_id = ${companyId}::uuid and w.id = ${workflowId}::uuid
    `.execute(this.database);
    if (workflow.rows[0] === undefined) this.notFound();

    const [tasks, comments, attachments, reviews, transitions] = await Promise.all([
      sql<Record<string, unknown>>`
        select t.id, t.task_key as "taskKey", t.task_label_snapshot as "taskLabel",
               t.sequence, t.is_mandatory as "isMandatory", t.status,
               t.check_result as "checkResult", t.checked_at as "checkedAt",
               t.assigned_to_account_id as "assignedToAccountId",
               a.username as "assignedToUsername",
               t.completed_by_account_id as "completedByAccountId",
               c.username as "completedByUsername", t.completed_at as "completedAt",
               t.notes, t.updated_at as "updatedAt", t.version
          from closing_workflow_tasks t
          left join accounts a on a.id = t.assigned_to_account_id and a.company_id = t.company_id
          left join accounts c on c.id = t.completed_by_account_id and c.company_id = t.company_id
         where t.company_id = ${companyId}::uuid and t.closing_workflow_id = ${workflowId}::uuid
         order by t.sequence, t.id
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select c.id, c.closing_workflow_task_id as "taskId", c.body,
               c.author_account_id as "authorAccountId", a.username as "authorUsername",
               c.created_at as "createdAt"
          from closing_task_comments c
          left join accounts a on a.id = c.author_account_id and a.company_id = c.company_id
         where c.company_id = ${companyId}::uuid and c.closing_workflow_id = ${workflowId}::uuid
         order by c.created_at, c.id
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select x.id, x.closing_workflow_task_id as "taskId", x.file_name as "fileName",
               x.content_type as "contentType", x.byte_size::text as "byteSize",
               x.storage_key as "storageKey",
               x.uploaded_by_account_id as "uploadedByAccountId",
               a.username as "uploadedByUsername", x.created_at as "createdAt"
          from closing_task_attachments x
          left join accounts a on a.id = x.uploaded_by_account_id and a.company_id = x.company_id
         where x.company_id = ${companyId}::uuid and x.closing_workflow_id = ${workflowId}::uuid
         order by x.created_at, x.id
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select r.id, r.review_stage as "reviewStage", r.decision, r.comments,
               r.decided_by_account_id as "decidedByAccountId", a.username as "decidedByUsername",
               r.decided_at as "decidedAt"
          from closing_workflow_reviews r
          left join accounts a on a.id = r.decided_by_account_id and a.company_id = r.company_id
         where r.company_id = ${companyId}::uuid and r.closing_workflow_id = ${workflowId}::uuid
         order by r.decided_at, r.id
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select h.id, h.from_status as "fromStatus", h.to_status as "toStatus", h.reason,
               h.actor_account_id as "actorAccountId", a.username as "actorUsername",
               h.correlation_id as "correlationId", h.created_at as "createdAt"
          from closing_workflow_transitions h
          left join accounts a on a.id = h.actor_account_id and a.company_id = h.company_id
         where h.company_id = ${companyId}::uuid and h.closing_workflow_id = ${workflowId}::uuid
         order by h.created_at, h.id
      `.execute(this.database),
    ]);
    return {
      ...workflow.rows[0],
      attachments: attachments.rows,
      comments: comments.rows,
      reviews: reviews.rows,
      tasks: tasks.rows,
      transitions: transitions.rows,
    };
  }

  /** Due date, priority, assignee and notes. Never the status. */
  public async updateWorkflow(workflowId: string, input: UpdateClosingWorkflowDto) {
    this.support.assertPermission("accounting.manage");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const workflow = await this.lockWorkflow(transaction, workflowId);
      this.assertMutable(workflow.status);
      if (input.assignedToAccountId !== undefined) {
        await this.assertCompanyAccount(transaction, input.assignedToAccountId);
      }
      await sql`
        update closing_workflows
           set due_date = coalesce(${input.dueDate ?? null}::date, due_date),
               priority = coalesce(${input.priority ?? null}::text, priority),
               assigned_to_account_id = coalesce(
                 ${input.assignedToAccountId ?? null}::uuid, assigned_to_account_id),
               notes = coalesce(${input.notes?.trim() ?? null}::text, notes),
               updated_by_account_id = ${actorId}::uuid, updated_at = now(),
               version = version + 1
         where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.updated",
        after: { ...input, workflowId },
        correlationId: workflowId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
      return { id: workflowId, updated: true };
    });
  }

  /**
   * Task status and notes.
   *
   * Completion is stamped with actor and instant together, and CLEARED together
   * when a task leaves `completed` -- the table's shape CHECK requires both or
   * neither, and a task reopened while still naming who completed it would be a
   * false record rather than a constraint violation.
   */
  public async updateTask(workflowId: string, taskId: string, input: UpdateClosingTaskDto) {
    this.support.assertPermission("accounting.manage");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const workflow = await this.lockWorkflow(transaction, workflowId);
      this.assertMutable(workflow.status);
      await this.assertTask(transaction, workflowId, taskId);
      const completing = input.status === "completed";
      const leavingCompleted = input.status !== undefined && input.status !== "completed";
      await sql`
        update closing_workflow_tasks
           set status = coalesce(${input.status ?? null}::text, status),
               notes = coalesce(${input.notes?.trim() ?? null}::text, notes),
               completed_by_account_id = case
                 when ${completing} then ${actorId}::uuid
                 when ${leavingCompleted} then null
                 else completed_by_account_id end,
               completed_at = case
                 when ${completing} then now()
                 when ${leavingCompleted} then null
                 else completed_at end,
               updated_at = now(), version = version + 1
         where id = ${taskId}::uuid and closing_workflow_id = ${workflowId}::uuid
           and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.support.audit(transaction, {
        action: "accounting.closing_task.updated",
        after: { ...input, taskId, workflowId },
        correlationId: workflowId,
        subjectId: taskId,
        subjectType: "closing_workflow_task",
      });
      return { id: taskId, updated: true };
    });
  }

  /** Assign or clear a task's owner. Assignee and instant move together. */
  public async assignTask(workflowId: string, taskId: string, input: AssignClosingTaskDto) {
    this.support.assertPermission("accounting.manage");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const workflow = await this.lockWorkflow(transaction, workflowId);
      this.assertMutable(workflow.status);
      await this.assertTask(transaction, workflowId, taskId);
      if (input.assignedToAccountId !== undefined) {
        await this.assertCompanyAccount(transaction, input.assignedToAccountId);
      }
      await sql`
        update closing_workflow_tasks
           set assigned_to_account_id = ${input.assignedToAccountId ?? null}::uuid,
               assigned_by_account_id = case
                 when ${input.assignedToAccountId ?? null}::uuid is null then null
                 else ${actorId}::uuid end,
               assigned_at = case
                 when ${input.assignedToAccountId ?? null}::uuid is null then null
                 else now() end,
               updated_at = now(), version = version + 1
         where id = ${taskId}::uuid and closing_workflow_id = ${workflowId}::uuid
           and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.support.audit(transaction, {
        action: "accounting.closing_task.assigned",
        after: { assignedToAccountId: input.assignedToAccountId ?? null, taskId, workflowId },
        correlationId: workflowId,
        subjectId: taskId,
        subjectType: "closing_workflow_task",
      });
      return { id: taskId, assigned: input.assignedToAccountId ?? null };
    });
  }

  /** Append-only. There is no edit and no delete. */
  public async addComment(workflowId: string, input: AddClosingCommentDto) {
    this.support.assertPermission("accounting.view");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      await this.lockWorkflow(transaction, workflowId);
      if (input.taskId !== undefined) {
        await this.assertTask(transaction, workflowId, input.taskId);
      }
      const created = await sql<{ createdAt: string; id: string }>`
        insert into closing_task_comments (
          company_id, closing_workflow_id, closing_workflow_task_id, body, author_account_id
        ) values (
          ${companyId}::uuid, ${workflowId}::uuid, ${input.taskId ?? null}::uuid,
          ${input.body.trim()}, ${actorId}::uuid
        )
        returning id, created_at as "createdAt"
      `.execute(transaction);
      return { createdAt: created.rows[0]!.createdAt, id: created.rows[0]!.id };
    });
  }

  /**
   * Attachment METADATA only.
   *
   * No bytes are stored and none are read. `storageKey` points at whatever the
   * Files module holds, so an attachment can be re-hosted without rewriting
   * closing evidence.
   */
  public async addAttachment(workflowId: string, input: AddClosingAttachmentDto) {
    this.support.assertPermission("accounting.manage");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      await this.lockWorkflow(transaction, workflowId);
      if (input.taskId !== undefined) {
        await this.assertTask(transaction, workflowId, input.taskId);
      }
      const created = await sql<{ createdAt: string; id: string }>`
        insert into closing_task_attachments (
          company_id, closing_workflow_id, closing_workflow_task_id, file_name,
          content_type, byte_size, storage_key, uploaded_by_account_id
        ) values (
          ${companyId}::uuid, ${workflowId}::uuid, ${input.taskId ?? null}::uuid,
          ${input.fileName.trim()}, ${input.contentType?.trim() || null},
          ${input.byteSize ?? null}::bigint, ${input.storageKey.trim()}, ${actorId}::uuid
        )
        returning id, created_at as "createdAt"
      `.execute(transaction);
      await this.support.audit(transaction, {
        action: "accounting.closing_attachment.added",
        after: { fileName: input.fileName, id: created.rows[0]!.id, workflowId },
        correlationId: workflowId,
        subjectId: created.rows[0]!.id,
        subjectType: "closing_task_attachment",
      });
      return { createdAt: created.rows[0]!.createdAt, id: created.rows[0]!.id };
    });
  }

  /**
   * Move a workflow to another status.
   *
   * Legality is `canTransition`'s answer, authority is this method's, and the
   * history row is written in the same transaction as the move -- a status that
   * changed without a transition row would be a status with no provenance.
   */
  public async transition(
    workflowId: string,
    input: TransitionClosingWorkflowDto,
    idempotencyKey?: string,
  ) {
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.closing-workflow.transition",
        payload: { ...input, workflowId },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;

      const workflow = await this.lockWorkflow(transaction, workflowId);
      if (workflow.version !== input.version) {
        this.conflict("accounting_closing_workflow_stale_version");
      }
      const from = workflow.status;
      const to = input.toStatus;
      if (!canTransition(from, to)) {
        throw new ApplicationException(
          "accounting_closing_transition_not_allowed",
          `A closing workflow cannot move from ${from} to ${to}`,
          HttpStatus.CONFLICT,
        );
      }
      // Close and Reopen are EXECUTION, and execution has its own endpoints
      // that move the accounting period in the same transaction. Allowing the
      // generic transition to write these statuses would let a workflow read
      // `closed` over a period that is still open.
      if (executionStatuses.includes(to)) {
        this.conflict("accounting_closing_use_execution_endpoint");
      }
      this.support.assertPermission(transitionPermission[to]);
      const reason = input.reason?.trim() ?? "";
      if (reasonRequired.includes(to) && reason === "") {
        this.conflict("accounting_closing_reason_required", HttpStatus.BAD_REQUEST);
      }
      await this.assertMakerChecker(transaction, workflow, to);
      // Readiness gate. The stored automated results are VALIDATED rather than
      // re-run: re-evaluating inside the transition would make advancing the
      // workflow also write to every task, so a rejected move would still have
      // changed the thing it was refusing to move.
      //
      // A mandatory automated check that was never evaluated is not a pass --
      // otherwise a workflow could reach approval by never running the checks.
      if (to === "ready_for_approval" || to === "approved") {
        await this.readiness.assertReadyForApproval(transaction, workflowId);
      }

      // Stage stamps. Each is written with its actor and instant together,
      // which is what the table's shape CHECKs require.
      const submitting = to === "ready_for_review";
      const reviewing = to === "ready_for_approval";
      const approving = to === "approved";
      const cancelling = to === "cancelled";
      await sql`
        update closing_workflows
           set status = ${to},
               submitted_by_account_id = case when ${submitting} then ${actorId}::uuid
                 else submitted_by_account_id end,
               submitted_at = case when ${submitting} then now() else submitted_at end,
               reviewed_by_account_id = case when ${reviewing} then ${actorId}::uuid
                 else reviewed_by_account_id end,
               reviewed_at = case when ${reviewing} then now() else reviewed_at end,
               approved_by_account_id = case when ${approving} then ${actorId}::uuid
                 else approved_by_account_id end,
               approved_at = case when ${approving} then now() else approved_at end,
               cancelled_at = case when ${cancelling} then now() else cancelled_at end,
               cancellation_reason = case when ${cancelling} then ${reason || null}
                 else cancellation_reason end,
               updated_by_account_id = ${actorId}::uuid, updated_at = now(),
               version = version + 1
         where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      // A review or approval DECISION gets its own row, never overwritten, so a
      // workflow that went round the loop three times shows three decisions.
      const decision =
        to === "changes_requested" ? "changes_requested" : approving || reviewing ? "approved" : null;
      if (decision !== null) {
        // The stage is where the decision was MADE, not where it sends the
        // workflow next. Changes requested after approval is an approval-stage
        // reversal; filing it as a review would misattribute who turned it back.
        const stage =
          approving || from === "ready_for_approval" || from === "approved" ? "approval" : "review";
        await sql`
          insert into closing_workflow_reviews (
            company_id, closing_workflow_id, review_stage, decision, comments,
            decided_by_account_id
          ) values (
            ${companyId}::uuid, ${workflowId}::uuid, ${stage}, ${decision},
            ${reason || null}, ${actorId}::uuid
          )
        `.execute(transaction);
      }

      const correlationId = await this.recordTransition(transaction, {
        correlationId: null,
        fromStatus: from,
        reason: reason || null,
        toStatus: to,
        workflowId,
      });

      const response = { from, id: workflowId, status: to, version: workflow.version + 1 };
      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.transitioned",
        after: { ...response, reason: reason || null },
        correlationId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
      if (idempotencyKey !== undefined) {
        await this.support.completeIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.closing-workflow.transition",
          resourceId: workflowId,
          resourceType: "closing_workflow",
          responseBody: response,
        });
      }
      return response;
    });
  }

  /**
   * Close the Monthly accounting period this workflow governs.
   *
   * =========================================================================
   * THE PERIOD AND THE WORKFLOW MOVE TOGETHER OR NEITHER MOVES
   * =========================================================================
   *
   * Both rows are locked and both are updated in ONE transaction. A period
   * closed while its workflow still reads `approved` would claim a control that
   * was never completed; a workflow reading `closed` over an open period would
   * claim a close that never happened. Either half alone is a lie, so the
   * transaction is the unit.
   *
   * It writes NO Journal and NO Accounting Event. Closing a period is a
   * statement about what may still be posted to it, not a financial event of
   * its own -- the Year-End closing entries are a separate, unimplemented step.
   */
  public async close(
    workflowId: string,
    input: CloseClosingWorkflowDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.approve");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      // Lock first, then fingerprint what was locked -- the version and reason
      // are what the caller is acting on, and hashing them after the lock means
      // a replay is judged against the row as it actually stands.
      const workflow = await this.lockWorkflow(transaction, workflowId);
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.closing-workflow.close",
        payload: { reason: input.reason?.trim() ?? "", version: input.version, workflowId },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;

      // Year-End closes a fiscal year, which means closing Journals, the
      // Profit/Loss transfer and carry-forward -- none of which exist. Refused
      // rather than approximated by moving a status.
      if (workflow.workflowType !== "monthly") {
        this.conflict("accounting_year_end_execution_not_implemented");
      }
      if (workflow.status !== "approved") {
        this.conflict("accounting_closing_workflow_not_closable");
      }
      if (workflow.version !== input.version) {
        this.conflict("accounting_closing_workflow_stale_version");
      }
      // The same rule the approval stage applies: whoever prepared this may not
      // be the one who executes it.
      if (workflow.submittedByAccountId !== null && workflow.submittedByAccountId === actorId) {
        this.conflict("accounting_closing_closer_is_submitter");
      }
      // Re-evaluated at the moment of execution, not trusted from approval
      // time: sources can regress between the two.
      await this.readiness.assertReadyForApproval(transaction, workflowId);

      const period = await this.lockPeriod(transaction, workflow);
      if (period.status === "closed") {
        this.conflict("accounting_closing_period_already_closed");
      }

      await sql`
        update accounting_periods
           set status = 'closed', closed_by_account_id = ${actorId}::uuid, closed_at = now(),
               close_reason = ${input.reason?.trim() || null}, version = version + 1
         where id = ${period.id}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await sql`
        update closing_workflows
           set status = 'closed', closed_at = now(),
               updated_by_account_id = ${actorId}::uuid, updated_at = now(),
               version = version + 1
         where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      const correlationId = await this.recordTransition(transaction, {
        correlationId: null,
        fromStatus: "approved",
        reason: input.reason?.trim() || null,
        toStatus: "closed",
        workflowId,
      });

      const response = {
        accountingPeriodId: period.id,
        id: workflowId,
        periodStatus: "closed",
        status: "closed",
        version: workflow.version + 1,
      };
      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.period_closed",
        after: { ...response, reason: input.reason?.trim() || null },
        correlationId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
      if (idempotencyKey !== undefined) {
        await this.support.completeIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.closing-workflow.close",
          resourceId: workflowId,
          resourceType: "closing_workflow",
          responseBody: response,
        });
      }
      return response;
    });
  }

  /**
   * Reopen a closed Monthly period.
   *
   * =========================================================================
   * IT UNDOES A STATE, NOT A HISTORY
   * =========================================================================
   *
   * Nothing is deleted or rewritten. The approval that closed the period, the
   * readiness results, the checklist, comments, attachments and the
   * `approved -> closed` transition all remain exactly as they were; a
   * `closed -> reopened` row is APPENDED beside them. A reopen that erased the
   * first close would leave nobody able to answer why the period was closed in
   * the first place, which is the question a reopen invites.
   *
   * =========================================================================
   * LATER PERIODS ARE A DEPENDENCY, NOT A DETAIL
   * =========================================================================
   *
   * A closed February cannot sit on top of a reopened January: the later close
   * was signed off against figures the reopen is about to allow to change.
   * Reopening the earlier period is refused rather than cascading, because
   * silently reopening February would undo a second person's sign-off without
   * their knowledge.
   */
  public async reopen(
    workflowId: string,
    input: ReopenClosingWorkflowDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.approve");
    const { actorId, companyId } = this.support.context();
    const reason = input.reason.trim();
    return this.transactions.execute(async (transaction) => {
      const workflow = await this.lockWorkflow(transaction, workflowId);
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.closing-workflow.reopen",
        payload: { reason, version: input.version, workflowId },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;

      if (workflow.workflowType !== "monthly") {
        this.conflict("accounting_year_end_execution_not_implemented");
      }
      if (workflow.status !== "closed") {
        this.conflict("accounting_closing_workflow_not_reopenable");
      }
      if (workflow.version !== input.version) {
        this.conflict("accounting_closing_workflow_stale_version");
      }
      if (reason === "") {
        this.conflict("accounting_closing_reason_required", HttpStatus.BAD_REQUEST);
      }

      const period = await this.lockPeriod(transaction, workflow);
      if (period.status !== "closed") {
        this.conflict("accounting_closing_period_not_closed");
      }

      // Both dependency questions in one Company-scoped read. Neither later
      // periods nor Year-End workflows are altered -- they are only consulted.
      const dependencies = await sql<{ laterClosed: number; yearEndClosed: number }>`
        select
          (select count(*)::int from accounting_periods p
            where p.company_id = ${companyId}::uuid
              and p.fiscal_year_id = ${workflow.fiscalYearId}::uuid
              and p.period_start > ${period.periodStart}::date
              and p.status = 'closed') as "laterClosed",
          (select count(*)::int from closing_workflows w
            where w.company_id = ${companyId}::uuid
              and w.fiscal_year_id = ${workflow.fiscalYearId}::uuid
              and w.workflow_type = 'year_end' and w.status = 'closed') as "yearEndClosed"
      `.execute(transaction);
      if ((dependencies.rows[0]?.laterClosed ?? 0) > 0) {
        this.conflict("accounting_closing_later_period_closed");
      }
      if ((dependencies.rows[0]?.yearEndClosed ?? 0) > 0) {
        this.conflict("accounting_closing_year_end_closed");
      }

      // `reopened`, with actor, instant and reason together -- the table's
      // `accounting_periods_reopen_check` rejects the status without all three.
      await sql`
        update accounting_periods
           set status = 'reopened', reopened_by_account_id = ${actorId}::uuid,
               reopened_at = now(), reopen_reason = ${reason}, version = version + 1
         where id = ${period.id}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await sql`
        update closing_workflows
           set status = 'reopened', updated_by_account_id = ${actorId}::uuid,
               updated_at = now(), version = version + 1
         where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      const correlationId = await this.recordTransition(transaction, {
        correlationId: null,
        fromStatus: "closed",
        reason,
        toStatus: "reopened",
        workflowId,
      });

      const response = {
        accountingPeriodId: period.id,
        id: workflowId,
        periodStatus: "reopened",
        status: "reopened",
        version: workflow.version + 1,
      };
      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.period_reopened",
        after: { ...response, reason },
        correlationId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
      if (idempotencyKey !== undefined) {
        await this.support.completeIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.closing-workflow.reopen",
          resourceId: workflowId,
          resourceType: "closing_workflow",
          responseBody: response,
        });
      }
      return response;
    });
  }

  /**
   * Lock the accounting period a Monthly workflow governs.
   *
   * Matched on Company AND fiscal year as well as id: a period that belonged to
   * another year would make the workflow's own year and period describe
   * different things, and the lock is the last moment that can be caught.
   */
  private async lockPeriod(
    database: Kysely<DatabaseSchema>,
    workflow: WorkflowRow,
  ): Promise<{ id: string; periodStart: string; status: string }> {
    const { companyId } = this.support.context();
    if (workflow.accountingPeriodId === null) {
      this.conflict("accounting_closing_period_required", HttpStatus.BAD_REQUEST);
    }
    const result = await sql<{ id: string; periodStart: string; status: string }>`
      select id, status, period_start::text as "periodStart"
        from accounting_periods
       where id = ${workflow.accountingPeriodId}::uuid and company_id = ${companyId}::uuid
         and fiscal_year_id = ${workflow.fiscalYearId}::uuid
       for update
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_closing_period_not_found",
        "The accounting period was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0]!;
  }

  /**
   * Maker-checker.
   *
   * The database forbids approver = submitter unconditionally, and this repeats
   * it with an actionable message rather than letting a raw constraint surface.
   *
   * The CREATOR rule is this service's own, and is conditional on another
   * authorised approver existing -- the same escape the General Expense payment
   * segregation uses. Without it, a Company whose only Accounting approver also
   * creates the workflows could never approve one, which is a deadlock rather
   * than a control.
   */
  private async assertMakerChecker(
    database: Kysely<DatabaseSchema>,
    workflow: WorkflowRow,
    to: ClosingWorkflowStatus,
  ): Promise<void> {
    if (to !== "approved" && to !== "ready_for_approval") return;
    const { actorId } = this.support.context();
    if (workflow.submittedByAccountId !== null && workflow.submittedByAccountId === actorId) {
      this.conflict(
        to === "approved"
          ? "accounting_closing_approver_is_submitter"
          : "accounting_closing_reviewer_is_submitter",
      );
    }
    if (
      to === "approved" &&
      workflow.createdByAccountId === actorId &&
      (await this.support.hasAlternateAuthorizedActor(database, "accounting.approve"))
    ) {
      this.conflict("accounting_closing_approver_is_creator");
    }
  }

  /**
   * The next `CLOSE-000001` for this Company.
   *
   * Deliberately NOT from `company_reference_counters`: that table's
   * `reference_type` CHECK is an allow-list which does not include
   * `closing_workflow`, so every attempt to use it was rejected at insert --
   * creating a closing workflow could not succeed at all. Adding the value
   * needs a migration, so the number is derived from the workflow table itself.
   *
   * The advisory lock is what makes that safe: it serialises numbering per
   * Company for the rest of the transaction, so two concurrent creates cannot
   * compute the same maximum. It is the same `pg_advisory_xact_lock` pattern
   * the Cash/Bank module uses to serialise account access, and the
   * `(company_id, workflow_number)` unique index remains the backstop.
   */
  private async nextWorkflowNumber(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<string> {
    await sql`select pg_advisory_xact_lock(
      hashtextextended('closing-workflow-number:' || ${companyId}, 0))`.execute(database);
    const result = await sql<{ next: string }>`
      select coalesce(
        max(nullif(regexp_replace(workflow_number, '\\D', '', 'g'), '')::bigint), 0
      ) + 1 as next
        from closing_workflows
       where company_id = ${companyId}::uuid
    `.execute(database);
    return `CLOSE-${String(result.rows[0]?.next ?? "1").padStart(6, "0")}`;
  }

  /** Insert-only. Returns the correlation reference it recorded. */
  private async recordTransition(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly correlationId: string | null;
      readonly fromStatus: ClosingWorkflowStatus | null;
      readonly reason: string | null;
      readonly toStatus: ClosingWorkflowStatus;
      readonly workflowId: string;
    },
  ): Promise<string> {
    const { actorId, companyId } = this.support.context();
    const inserted = await sql<{ correlationId: string }>`
      insert into closing_workflow_transitions (
        company_id, closing_workflow_id, from_status, to_status, reason,
        actor_account_id, correlation_id
      ) values (
        ${companyId}::uuid, ${input.workflowId}::uuid, ${input.fromStatus},
        ${input.toStatus}, ${input.reason}, ${actorId}::uuid,
        coalesce(${input.correlationId}::uuid, gen_random_uuid())
      )
      returning correlation_id::text as "correlationId"
    `.execute(database);
    return inserted.rows[0]!.correlationId;
  }

  private async lockWorkflow(
    database: Kysely<DatabaseSchema>,
    workflowId: string,
  ): Promise<WorkflowRow> {
    const { companyId } = this.support.context();
    const result = await sql<WorkflowRow>`
      select id, workflow_number as "workflowNumber", status, version,
             workflow_type as "workflowType", fiscal_year_id as "fiscalYearId",
             accounting_period_id as "accountingPeriodId",
             created_by_account_id as "createdByAccountId",
             submitted_by_account_id as "submittedByAccountId"
        from closing_workflows
       where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
       for update
    `.execute(database);
    if (result.rows[0] === undefined) this.notFound();
    return result.rows[0]!;
  }

  /** A finished workflow is evidence, not a working document. */
  private assertMutable(status: ClosingWorkflowStatus): void {
    if (status === "closed" || status === "cancelled") {
      this.conflict("accounting_closing_workflow_not_editable");
    }
  }

  private async assertTask(
    database: Kysely<DatabaseSchema>,
    workflowId: string,
    taskId: string,
  ): Promise<void> {
    const { companyId } = this.support.context();
    const result = await sql<{ id: string }>`
      select id from closing_workflow_tasks
       where id = ${taskId}::uuid and closing_workflow_id = ${workflowId}::uuid
         and company_id = ${companyId}::uuid
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_closing_task_not_found",
        "The closing checklist task was not found",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * An account from another Company is reported as not found, identically to
   * one that does not exist: distinguishing them would let a caller enumerate
   * another tenant's account ids.
   */
  private async assertCompanyAccount(
    database: Kysely<DatabaseSchema>,
    accountId: string,
  ): Promise<void> {
    const { companyId } = this.support.context();
    const result = await sql<{ id: string }>`
      select id from accounts
       where id = ${accountId}::uuid and company_id = ${companyId}::uuid and status = 'active'
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_closing_account_not_found",
        "The selected user was not found",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private notFound(): never {
    throw new ApplicationException(
      "accounting_closing_workflow_not_found",
      "The closing workflow was not found",
      HttpStatus.NOT_FOUND,
    );
  }

  private conflict(code: string, status: number = HttpStatus.CONFLICT): never {
    throw new ApplicationException(
      code,
      "The closing workflow operation is not allowed",
      status,
    );
  }
}
