import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { OperationalAccountingEventRecord } from "./operational-source.loader.js";

@Injectable()
export class AccountingEventRepository {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async next(workerId: string): Promise<OperationalAccountingEventRecord | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const result = await sql<OperationalAccountingEventRecord>`
        select e.id,e.company_id as "companyId",e.event_type as "eventType",
               e.event_version as "eventVersion",e.source_entity_type as "sourceEntityType",
               e.source_entity_id as "sourceEntityId",e.source_reference as "sourceReference",
               e.effective_accounting_date::text as "effectiveAccountingDate",
               e.correlation_id as "correlationId",e.event_hash as "eventHash",
               e.actor_id as "actorId",e.operational_area as "operationalArea",
               e.reversal_of_event_id as "reversalOfEventId"
          from accounting_events e
          join accounting_configurations c on c.company_id=e.company_id
         where e.processing_status in ('received','retry_pending')
           and coalesce(e.next_attempt_at,now())<=now()
           and c.accounting_enabled and c.automatic_posting_enabled
           and e.operational_area=any(c.automatic_posting_areas)
         order by e.created_at,e.id
         for update of e skip locked limit 1
      `.execute(transaction);
      const event = result.rows[0];
      if (event === undefined) return undefined;
      await sql`
        update accounting_events
           set processing_status='processing',attempt_count=attempt_count+1,
               last_attempt_at=now(),processing_locked_at=now(),
               processing_locked_by=${workerId},error_code=null,error_metadata=null,
               safe_error_summary=null
         where id=${event.id}::uuid and company_id=${event.companyId}::uuid
      `.execute(transaction);
      return event;
    });
  }

  public async recoverStaleLocks(): Promise<void> {
    await sql`
      update accounting_events
         set processing_status=case when attempt_count<max_attempts then 'retry_pending' else 'failed' end,
             next_attempt_at=case when attempt_count<max_attempts then now() else null end,
             processing_locked_at=null,processing_locked_by=null,
             failure_category='transient',error_code='accounting_event_processing_interrupted',
             safe_error_summary='Processing was interrupted and the durable Event was recovered'
       where processing_status='processing'
         and processing_locked_at<now()-interval '5 minutes'
    `.execute(this.database);
  }
}
