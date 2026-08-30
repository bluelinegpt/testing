import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { CreateWorkflowTestRunDto } from "./platform-workflow-testing.dto.js";
import { PlatformWorkflowBrowserWorker } from "./platform-workflow-browser.worker.js";

type Actor = { accountId: string };

export function workflowTestRejection(company:{name:string;environment:string;enabledAt:string|null},input:{mode:"full"|"smoke";ordersPerDay:number;durationDays:number;sideEffectsSuppressed:boolean}):string|null {
  if(/dana/i.test(company.name)) return "dana_workflow_testing_blocked";
  if(input.mode==="full"&&company.enabledAt===null) return "company_not_enabled_for_full_workflow_testing";
  if(input.mode==="full"&&!input.sideEffectsSuppressed) return "side_effect_suppression_required";
  if(input.mode==="smoke"&&input.ordersPerDay*input.durationDays>5) return "smoke_test_maximum_is_five_orders";
  return null;
}

@Injectable()
export class PlatformWorkflowTestingService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,@Inject(PlatformWorkflowBrowserWorker) private readonly worker:PlatformWorkflowBrowserWorker) {}

  public async eligibleCompanies() {
    return (await sql<{id:string;code:string;name:string;environment:string;enabled:boolean}>`
      select id,code,name_en name,environment,workflow_testing_enabled_at is not null enabled
        from companies
       where environment<>'production'
         and lower(subdomain)<>'dana' and lower(name_en) not like 'dana delivery%'
       order by name_en
    `.execute(this.database)).rows;
  }

  public async list() {
    return (await sql<Record<string,unknown>>`
      select r.*,c.name_en "companyName",c.code "companyCode",
             jsonb_build_object(
               'linked',count(s.generated_order_id),
               'scenarios',count(s.id),
               'completed',count(s.id) filter(where o.delivery_status='closed'),
               'failed',count(s.id) filter(where s.status='failed'),
               'inProgress',count(s.id) filter(where o.id is not null and o.delivery_status<>'closed' and s.status<>'failed')
             ) as progress,
             case when r.status='draft' and count(s.id)=r.planned_orders and bool_and(o.delivery_status='closed')
                  then 'completed' else r.status end as status,
             coalesce(jsonb_agg(s.safe_error order by s.created_at) filter(where s.safe_error is not null),'[]'::jsonb) "failureReasons"
        from platform_workflow_test_runs r join companies c on c.id=r.company_id
        left join platform_workflow_test_scenarios s on s.run_id=r.id
        left join orders o on o.id=s.generated_order_id and o.company_id=r.company_id
       group by r.id,c.name_en,c.code
       order by r.created_at desc limit 100
    `.execute(this.database)).rows;
  }

  public async connectRecentOrders(id:string,expectedVersion:number) {
    return this.database.transaction().execute(async transaction=>{
      const normalizedExpectedVersion=Number(expectedVersion);
      if(!Number.isSafeInteger(normalizedExpectedVersion)||normalizedExpectedVersion<1) throw new BadRequestException("workflow_test_invalid_version");
      const run=(await sql<{id:string;companyId:string;plannedOrders:number;status:string;version:string;companyName:string;environment:string;enabledAt:string|null}>`
        select r.id,r.company_id "companyId",r.planned_orders "plannedOrders",r.status,r.version::text,
               c.name_en "companyName",c.environment,c.workflow_testing_enabled_at "enabledAt"
          from platform_workflow_test_runs r join companies c on c.id=r.company_id
         where r.id=${id}::uuid for update of r
      `.execute(transaction)).rows[0];
      if(!run) throw new NotFoundException("workflow_test_run_not_found");
      if(run.status!=="draft"||Number(run.version)!==normalizedExpectedVersion) throw new ConflictException("workflow_test_version_or_state_conflict");
      if(run.enabledAt===null||run.environment==="production"||/dana/i.test(run.companyName)) throw new BadRequestException("workflow_test_company_not_eligible");
      const linked=(await sql<{count:string}>`select count(*)::text count from platform_workflow_test_scenarios where run_id=${id}::uuid`.execute(transaction)).rows[0];
      const remaining=run.plannedOrders-Number(linked?.count??0);
      if(remaining<=0) throw new BadRequestException("workflow_test_all_orders_already_connected");
      const orders=(await sql<{id:string;deliveryStatus:string}>`
        select o.id,o.delivery_status "deliveryStatus" from orders o
         where o.company_id=${run.companyId}::uuid
           and o.created_at >= (select created_at from platform_workflow_test_runs where id=${id}::uuid)
           and not exists(select 1 from platform_workflow_test_scenarios s where s.generated_order_id=o.id)
         order by o.created_at desc,o.id limit ${remaining}
      `.execute(transaction)).rows.reverse();
      if(orders.length===0) throw new BadRequestException("no_recent_unlinked_test_orders_found");
      for(const order of orders){
        await sql`insert into platform_workflow_test_scenarios(id,run_id,company_id,channel,outcome,language,viewport,status,generated_order_id,started_at,completed_at)
          values(${randomUUID()}::uuid,${id}::uuid,${run.companyId}::uuid,'company_portal','manual_full_cycle','en','desktop',
          ${order.deliveryStatus==="closed"?"passed":"running"},${order.id}::uuid,now(),${order.deliveryStatus==="closed"?new Date():null})`.execute(transaction);
      }
      const nextVersion=normalizedExpectedVersion+1;
      await sql`update platform_workflow_test_runs set version=${nextVersion},updated_at=now() where id=${id}::uuid`.execute(transaction);
      return {id,connected:orders.length,version:nextVersion};
    });
  }

  public async enableCompany(companyId:string,confirmation:string) {
    const company=(await sql<{id:string;code:string;name:string;environment:string}>`
      select id,code,name_en name,environment from companies where id=${companyId}::uuid
    `.execute(this.database)).rows[0];
    if(!company) throw new NotFoundException("company_not_found");
    if(/dana/i.test(company.name)) throw new BadRequestException("dana_workflow_testing_blocked");
    if(company.environment==="production") throw new BadRequestException("production_company_workflow_testing_blocked");
    if(confirmation!==`ENABLE ${company.code}`) throw new BadRequestException("workflow_testing_confirmation_mismatch");
    await sql`update companies set workflow_testing_enabled_at=coalesce(workflow_testing_enabled_at,now()) where id=${companyId}::uuid`.execute(this.database);
    return {companyId,enabled:true};
  }

  public async create(input: CreateWorkflowTestRunDto, actor: Actor) {
    const company=(await sql<{id:string;name:string;environment:string;enabledAt:string|null}>`
      select id,name_en name,environment,workflow_testing_enabled_at "enabledAt"
        from companies where id=${input.companyId}::uuid
    `.execute(this.database)).rows[0];
    if(!company) throw new NotFoundException("company_not_found");
    const rejection=workflowTestRejection(company,input);
    if(rejection) throw new BadRequestException(rejection);
    const id=randomUUID();
    await sql`insert into platform_workflow_test_runs(id,company_id,mode,orders_per_day,duration_days,concurrency,configuration,side_effects_suppressed,created_by_account_id)
      values(${id}::uuid,${input.companyId}::uuid,${input.mode},${input.ordersPerDay},${input.durationDays},${input.concurrency},${JSON.stringify(input.configuration)}::jsonb,${input.sideEffectsSuppressed},${actor.accountId}::uuid)`.execute(this.database);
    return {id,status:"draft",plannedOrders:input.ordersPerDay*input.durationDays,version:1};
  }

  public async mutate(id:string,action:"start"|"pause"|"resume"|"stop"|"cancel",expectedVersion:number) {
    if(action==="start") {
      const linked=(await sql<{count:string}>`select count(*)::text count from platform_workflow_test_scenarios where run_id=${id}::uuid`.execute(this.database)).rows[0];
      if(Number(linked?.count??0)>0) throw new BadRequestException("connected_manual_run_cannot_be_started_create_a_new_plan");
    }
    const allowed:Record<typeof action,readonly string[]>={start:["draft","scheduled"],pause:["running"],resume:["paused"],stop:["scheduled","running","paused"],cancel:["draft"]};
    const target={start:"scheduled",pause:"paused",resume:"running",stop:"stopping",cancel:"cancelled"}[action];
    const result=await sql<{version:string}>`update platform_workflow_test_runs set status=${target},version=version+1,updated_at=now(),
      started_at=case when ${action}='start' then coalesce(started_at,now()) else started_at end,
      paused_at=case when ${action}='pause' then now() else paused_at end
      where id=${id}::uuid and version=${expectedVersion} and status=any(${allowed[action]}) returning version::text`.execute(this.database);
    if(result.rows.length===0) throw new ConflictException("workflow_test_version_or_state_conflict");
    if(action==="start") this.worker.schedule(id);
    return {id,status:target,version:Number(result.rows[0]!.version)};
  }
}
