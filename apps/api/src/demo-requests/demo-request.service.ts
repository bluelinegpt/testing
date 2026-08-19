import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { CreateDemoRequestDto } from "./demo-request.dto.js";

const allowedTransitions: Record<string, readonly string[]> = {
  new: ["reviewing","contacted","qualified","rejected","closed"], reviewing: ["contacted","qualified","rejected","closed"],
  contacted: ["qualified","demo_scheduled","not_interested","rejected","closed"], qualified: ["demo_scheduled","converted","not_interested","closed"],
  demo_scheduled: ["converted","not_interested","closed"], converted: ["closed"], not_interested: ["closed"], rejected: ["closed"], closed: [],
};

function clean(value: string | undefined): string | null { if (value === undefined || value.trim() === "") return null; return value.replace(/[<>]/g, "").trim(); }
const dialingCodes: Record<string,string> = { "United Arab Emirates":"971", "Saudi Arabia":"966", Oman:"968", Qatar:"974", Kuwait:"965", Bahrain:"973", Jordan:"962", Egypt:"20", Iraq:"964", Lebanon:"961", Morocco:"212", Pakistan:"92", India:"91", "United Kingdom":"44", "United States":"1" };
export function normalizeMobile(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^05\d{8}$/.test(digits)) return `+971${digits.slice(1)}`;
  if (/^9715\d{8}$/.test(digits)) return `+${digits}`;
  if (/^5\d{8}$/.test(digits)) return `+971${digits}`;
  if (/^\+\d[\d\s().-]{6,24}$/.test(trimmed) && digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  if (/^\d{7,15}$/.test(digits)) return digits;
  throw new BadRequestException("Please enter a valid mobile number.");
}
function normalizeMobileForCountry(value:string,country:string):string{const trimmed=value.trim(); const digits=trimmed.replace(/\D/g,""); if(trimmed.startsWith("+") && digits.length>=7 && digits.length<=15) return `+${digits}`; if(country==="United Arab Emirates") return normalizeMobile(value); const code=dialingCodes[country]; if(code && digits.length>=6 && digits.length<=14) return `+${code}${digits.replace(/^0+/,"")}`; return normalizeMobile(value);}
function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}
function digitsOnly(value:string):string{return value.replace(/\D/g,"");}
function mapRow(row: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase()), value])); }
function withoutPrivateColumns(row: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "total_count" && key !== "submission_fingerprint")); }

@Injectable()
export class DemoRequestService {
  public constructor(@Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>) {}

  private async recordAudit(input: { action:string; actorAccountId:string; subjectId:string; correlationId:string; ip?:string|undefined; userAgent?:string|undefined; before?:object; after?:object; reason?:string|null }): Promise<void> {
    await sql`insert into audit_events (company_id,actor_account_id,action,subject_type,subject_id,reason,before_data,after_data,correlation_id,ip_address,user_agent,actor_role,source,result,failure_reason,source_application) values (null,${input.actorAccountId}::uuid,${input.action},'platform_demo_request',${input.subjectId},${input.reason ?? null},${input.before ? JSON.stringify(input.before) : null}::jsonb,${input.after ? JSON.stringify(input.after) : null}::jsonb,${input.correlationId},${input.ip ?? null}::inet,${input.userAgent?.slice(0,1000) ?? null},'platform_administrator','platform_portal','success',null,'platform-web')`.execute(this.db);
  }

  public async create(input: CreateDemoRequestDto, requestMeta: { ip: string | null; userAgent: string | null }): Promise<{ id: string; referenceNumber: string }> {
    if ((input.companyFax ?? "") !== "") throw new BadRequestException("The request could not be submitted");
    const mobile = normalizeMobileForCountry(input.mobileNumber,input.country);
    const email = input.email.trim().toLowerCase();
    const fingerprint = createHash("sha256").update(`${input.companyName.trim().toLowerCase()}|${mobile}|${email}`).digest("hex");
    const result = await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`.execute(trx);
      const duplicate = await sql<{ id: string; reference_number: string }>`select id, reference_number from platform_demo_requests where submission_fingerprint=${fingerprint} and created_at > now() - interval '15 minutes' order by created_at desc limit 1`.execute(trx);
      if (duplicate.rows[0]) throw new ConflictException(`A recent request was already received. Reference: ${duplicate.rows[0].reference_number}`);
      const inserted = await sql<{ id: string; reference_number: string }>`
        with next_reference as (select nextval('platform_demo_request_reference_seq') as value)
        insert into platform_demo_requests (reference_number,company_name,contact_person,mobile_number,email,country,emirate,website,approximate_driver_count,approximate_monthly_orders,approximate_trader_count,current_system,preferred_contact_method,main_challenges,features_of_interest,notes,source,landing_page,referrer,utm_source,utm_medium,utm_campaign,utm_term,utm_content,gclid,submission_fingerprint)
        select 'DEMO-' || lpad(value::text,6,'0'), ${clean(input.companyName)}, ${clean(input.contactPerson)}, ${mobile}, ${email}, ${clean(input.country)}, ${input.emirate ?? null}, ${clean(input.website)}, ${input.approximateDriverCount ?? null}, ${input.approximateMonthlyOrders ?? null}, ${input.approximateTraderCount ?? null}, ${clean(input.currentSystem)}, ${input.preferredContactMethod}, ${clean(input.mainChallenges)}, ${input.featuresOfInterest ?? []}, ${clean(input.additionalNotes)}, 'public_website', ${input.landingPage.slice(0,500)}, ${clean(input.referrer)}, ${clean(input.utmSource)}, ${clean(input.utmMedium)}, ${clean(input.utmCampaign)}, ${clean(input.utmTerm)}, ${clean(input.utmContent)}, ${clean(input.gclid)}, ${fingerprint} from next_reference returning id, reference_number
      `.execute(trx);
      const row = inserted.rows[0]; if (!row) throw new Error("Demo request insert returned no row");
      await sql`insert into platform_demo_request_history (demo_request_id,from_status,to_status,detail) values (${row.id}::uuid,null,'new',${JSON.stringify({ source: "public_website", ipCaptured: requestMeta.ip !== null, userAgentCaptured: requestMeta.userAgent !== null })}::jsonb)`.execute(trx);
      await this.createAgentConversationForDemo(trx,{id:row.id,referenceNumber:row.reference_number,input,mobile,email});
      return { id: row.id, referenceNumber: row.reference_number };
    });
    return result;
  }

  private async createAgentConversationForDemo(trx:Kysely<DatabaseSchema>,data:{id:string;referenceNumber:string;input:CreateDemoRequestDto;mobile:string;email:string;}):Promise<void>{
    const {id,referenceNumber,input,mobile,email}=data;
    const agentReference=`AGT-${String((await sql<{n:string}>`select nextval('platform_agent_conversation_reference_seq')::text n`.execute(trx)).rows[0]!.n).padStart(6,"0")}`;
    const snapshot={source:"public_website_demo",demoReference:referenceNumber,company:{name:input.companyName,country:input.country,emirate:input.emirate ?? null},contact:{name:input.contactPerson,mobile,email,preferredContactMethod:input.preferredContactMethod},operations:{approximateMonthlyOrders:input.approximateMonthlyOrders ?? null,approximateDriverCount:input.approximateDriverCount ?? null,featuresOfInterest:input.featuresOfInterest ?? [],mainChallenge:clean(input.mainChallenges)},status:"new"};
    const featureText=(input.featuresOfInterest ?? []).length ? ` Interested in ${(input.featuresOfInterest ?? []).join(", ").replace(/_/g," ")}.` : "";
    const userSummary=`Demo request ${referenceNumber}: ${input.contactPerson} from ${input.companyName} (${input.country}) requested a Tawseelhub demo. Preferred contact: ${input.preferredContactMethod}. Mobile: ${mobile}. Email: ${email}.${featureText}`;
    const assistantSummary=`Demo request received. Reference: ${referenceNumber}. The Tawseelhub team will contact the prospect using the preferred contact method.`;
    const conversation=(await sql<{id:string}>`insert into platform_agent_conversations(reference_number,public_session_token_hash,channel,channel_subject_hash,language,current_intent,status,requester_type,state,linked_demo_request_id,customer_name,mobile_number,mobile_number_normalized,email,audience,last_message_at,operational_classification,review_status)
      values(${agentReference},${hash(`public_demo_form:${id}:${referenceNumber}`)},'website',${hash(mobile)},'en','delivery_company_demo','completed','delivery_company',${JSON.stringify(snapshot)}::jsonb,${id}::uuid,${input.contactPerson},${mobile},${digitsOnly(mobile)},${email},'delivery_company',now(),'demo_request','new') returning id`.execute(trx)).rows[0]!;
    await sql`insert into platform_agent_messages(conversation_id,sender_type,content,structured_payload) values
      (${conversation.id}::uuid,'user',${userSummary},${JSON.stringify(snapshot)}::jsonb),
      (${conversation.id}::uuid,'assistant',${assistantSummary},${JSON.stringify({demoReference:referenceNumber,status:"new"})}::jsonb)`.execute(trx);
    await sql`insert into platform_agent_actions(conversation_id,action_type,status,request_snapshot,response_snapshot) values(${conversation.id}::uuid,'demo_request','completed',${JSON.stringify(snapshot)}::jsonb,${JSON.stringify({demoReference:referenceNumber,status:"new"})}::jsonb)`.execute(trx);
  }

  public async list(filters: { search?: string; status?: string; country?: string; emirate?: string; preferredContactMethod?: string; createdFrom?: string; createdTo?: string; page: number; pageSize: number; sort: "newest" | "oldest" }): Promise<object> {
    const offset=(filters.page-1)*filters.pageSize; const search=filters.search?.trim() || null;
    const result=await sql<Record<string,unknown>>`select r.*, a.username as assigned_to_username, ac.reference_number as agent_conversation_reference, count(*) over()::int as total_count from platform_demo_requests r left join accounts a on a.id=r.assigned_to left join platform_agent_conversations ac on ac.linked_demo_request_id=r.id where (${search}::text is null or r.reference_number ilike '%'||${search}||'%' or r.company_name ilike '%'||${search}||'%' or r.contact_person ilike '%'||${search}||'%' or r.mobile_number ilike '%'||${search}||'%' or r.email ilike '%'||${search}||'%' or r.country ilike '%'||${search}||'%' or ac.reference_number ilike '%'||${search}||'%') and (${filters.status ?? null}::text is null or r.status=${filters.status ?? null}) and (${filters.country ?? null}::text is null or r.country ilike ${filters.country ?? null}) and (${filters.emirate ?? null}::text is null or r.emirate=${filters.emirate ?? null}) and (${filters.preferredContactMethod ?? null}::text is null or r.preferred_contact_method=${filters.preferredContactMethod ?? null}) and (${filters.createdFrom ?? null}::date is null or r.created_at >= ${filters.createdFrom ?? null}::date) and (${filters.createdTo ?? null}::date is null or r.created_at < ${filters.createdTo ?? null}::date + interval '1 day') order by case when ${filters.sort}='oldest' then r.created_at end asc, case when ${filters.sort}='newest' then r.created_at end desc limit ${filters.pageSize} offset ${offset}`.execute(this.db);
    return { items: result.rows.map((row) => mapRow(withoutPrivateColumns(row))), total: Number(result.rows[0]?.total_count ?? 0), page: filters.page, pageSize: filters.pageSize };
  }

  public async detail(id: string): Promise<object> { const lead=await sql<Record<string,unknown>>`select r.*, a.username assigned_to_username, c.name_en converted_company_name, ac.id agent_conversation_id, ac.reference_number agent_conversation_reference from platform_demo_requests r left join accounts a on a.id=r.assigned_to left join companies c on c.id=r.converted_company_id left join platform_agent_conversations ac on ac.linked_demo_request_id=r.id where r.id=${id}::uuid`.execute(this.db); if(!lead.rows[0]) throw new NotFoundException("Demo request not found"); const history=await sql<Record<string,unknown>>`select h.*, a.username actor_username from platform_demo_request_history h left join accounts a on a.id=h.actor_account_id where h.demo_request_id=${id}::uuid order by h.created_at`.execute(this.db); const notes=await sql<Record<string,unknown>>`select n.*, a.username author_username from platform_demo_request_notes n left join accounts a on a.id=n.author_account_id where n.demo_request_id=${id}::uuid order by n.created_at`.execute(this.db); return { ...mapRow(withoutPrivateColumns(lead.rows[0])), history: history.rows.map(mapRow), internalNotes: notes.rows.map(mapRow) }; }

  public async transition(id: string, status: string, options: { reason?: string|undefined; demoScheduledAt?: string|undefined; convertedCompanyId?: string|undefined }, actor: { accountId: string; correlationId: string; ip?: string|undefined; userAgent?: string|undefined }): Promise<object> { const before=await this.detail(id) as Record<string,unknown>; const current=String(before.status); if(!allowedTransitions[current]?.includes(status)) throw new BadRequestException(`Cannot move a lead from ${current} to ${status}`); if(["not_interested","rejected","closed"].includes(status) && !options.reason?.trim()) throw new BadRequestException("A reason is required for this status"); await this.db.transaction().execute(async trx=>{ await sql`update platform_demo_requests set status=${status}, contacted_at=case when ${status}='contacted' then coalesce(contacted_at,now()) else contacted_at end, qualified_at=case when ${status}='qualified' then coalesce(qualified_at,now()) else qualified_at end, demo_scheduled_at=case when ${status}='demo_scheduled' then ${options.demoScheduledAt ?? null}::timestamptz else demo_scheduled_at end, converted_at=case when ${status}='converted' then coalesce(converted_at,now()) else converted_at end, converted_company_id=case when ${status}='converted' then ${options.convertedCompanyId ?? null}::uuid else converted_company_id end, closed_at=case when ${status} in ('not_interested','rejected','closed') then coalesce(closed_at,now()) else closed_at end, close_reason=case when ${status} in ('not_interested','rejected','closed') then ${clean(options.reason)} else close_reason end, updated_at=now() where id=${id}::uuid`.execute(trx); await sql`insert into platform_demo_request_history (demo_request_id,from_status,to_status,actor_account_id,detail) values (${id}::uuid,${current},${status},${actor.accountId}::uuid,${JSON.stringify({ reason: clean(options.reason), demoScheduledAt: options.demoScheduledAt ?? null, convertedCompanyId: options.convertedCompanyId ?? null })}::jsonb)`.execute(trx); }); await this.recordAudit({action:"platform.demo_request.status_changed",actorAccountId:actor.accountId,subjectId:id,before:{status:current},after:{status},reason:clean(options.reason),correlationId:actor.correlationId,ip:actor.ip,userAgent:actor.userAgent}); return this.detail(id); }

  public async addNote(id:string,text:string,actor:{accountId:string;correlationId:string;ip?:string|undefined;userAgent?:string|undefined}):Promise<object>{ await this.detail(id); const row=await sql<Record<string,unknown>>`insert into platform_demo_request_notes (demo_request_id,author_account_id,note_text) values (${id}::uuid,${actor.accountId}::uuid,${clean(text)}) returning *`.execute(this.db); await this.recordAudit({action:"platform.demo_request.note_added",actorAccountId:actor.accountId,subjectId:id,after:{noteAdded:true},correlationId:actor.correlationId,ip:actor.ip,userAgent:actor.userAgent}); return mapRow(row.rows[0] ?? {}); }
}
