import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";

import { SessionTokenService } from "../authentication/session-token.service.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { redactSensitiveText } from "../observability/error-report-redaction.js";

type Run = { id:string; companyId:string; companyName:string; subdomain:string; plannedOrders:number; environment:string; enabledAt:string|null };

@Injectable()
export class PlatformWorkflowBrowserWorker {
  private readonly logger=new Logger(PlatformWorkflowBrowserWorker.name);
  private readonly active=new Set<string>();

  public constructor(
    @Inject(DATABASE) private readonly database:Kysely<DatabaseSchema>,
    @Inject(SessionTokenService) private readonly tokens:SessionTokenService,
  ){}

  public schedule(runId:string):void {
    if(this.active.has(runId)) return;
    this.active.add(runId);
    setImmediate(()=>void this.execute(runId).finally(()=>this.active.delete(runId)));
  }

  private async execute(runId:string):Promise<void> {
    let browser:Browser|undefined;
    try {
      const run=await this.loadRun(runId);
      if(!run||run.environment==="production"||run.enabledAt===null||/dana/i.test(run.companyName)) throw new Error("workflow_test_company_not_eligible");
      const session=await this.issueSession(run.companyId);
      const baseUrl=this.companyUrl(run.subdomain);
      browser=await chromium.launch({headless:true});
      const context=await browser.newContext();
      await context.addCookies([{name:"blueline_session",value:session.token,url:`${baseUrl}/api`,httpOnly:true,sameSite:"Lax",secure:baseUrl.startsWith("https:")}]);
      await sql`update platform_workflow_test_runs set status='running',version=version+1,updated_at=now() where id=${runId}::uuid and status='scheduled'`.execute(this.database);
      for(let index=0;index<run.plannedOrders;index+=1){
        const current=(await sql<{status:string}>`select status from platform_workflow_test_runs where id=${runId}::uuid`.execute(this.database)).rows[0];
        if(!current||!["running","scheduled"].includes(current.status)) break;
        const scenarioId=randomUUID();
        await sql`insert into platform_workflow_test_scenarios(id,run_id,company_id,channel,outcome,language,viewport,status,started_at)
          values(${scenarioId}::uuid,${runId}::uuid,${run.companyId}::uuid,'company_portal','automated_free_order_full_cycle','en','desktop','running',now())`.execute(this.database);
        const page=await context.newPage();
        try {
          const orderId=await this.runScenario(page,baseUrl,run,index,scenarioId);
          await sql`update platform_workflow_test_scenarios set status='passed',generated_order_id=${orderId}::uuid,completed_at=now() where id=${scenarioId}::uuid`.execute(this.database);
        } catch(error) {
          const rawError=error instanceof Error?error.message:"workflow_browser_step_failed";
          const safeError=(redactSensitiveText(rawError)??"workflow_browser_step_failed").replaceAll(/\u001b\[[0-9;]*m/gu,"").slice(0,500);
          await sql`update platform_workflow_test_scenarios set status='failed',safe_error=${safeError},completed_at=now() where id=${scenarioId}::uuid`.execute(this.database);
        } finally { await page.close(); }
      }
      const failed=Number((await sql<{count:string}>`select count(*)::text count from platform_workflow_test_scenarios where run_id=${runId}::uuid and status='failed'`.execute(this.database)).rows[0]?.count??0);
      await sql`update platform_workflow_test_runs set status=${failed===0?"completed":"failed"},completed_at=now(),version=version+1,updated_at=now() where id=${runId}::uuid and status in('running','scheduled','stopping')`.execute(this.database);
      await this.revokeSession(session.hash);
    } catch(error) {
      this.logger.error(`Workflow test ${runId} failed`,error instanceof Error?error.stack:undefined);
      await sql`update platform_workflow_test_runs set status='failed',completed_at=now(),version=version+1,updated_at=now() where id=${runId}::uuid and status in('scheduled','running')`.execute(this.database).catch(()=>undefined);
    } finally { await browser?.close(); }
  }

  private async runScenario(page:Page,baseUrl:string,run:Run,index:number,scenarioId:string):Promise<string> {
    const serial=`WF-${run.id.slice(0,8)}-${String(index+1).padStart(4,"0")}`;
    const fixture=(await sql<{traderName:string;customerName:string;driverId:string;driverName:string}>`
      select t.name_en "traderName",customer.name "customerName",d.id "driverId",d.name_en "driverName"
        from traders t cross join lateral(select id,name_en from drivers where company_id=${run.companyId}::uuid and account_status='active' order by created_at limit 1)d
        cross join lateral(select c.name from customers c where c.company_id=${run.companyId}::uuid and c.status='active' and exists(select 1 from customer_addresses ca where ca.company_id=c.company_id and ca.customer_id=c.id and ca.is_active=true) order by c.created_at limit 1)customer
       where t.company_id=${run.companyId}::uuid and t.account_status='active' order by t.created_at limit 1
    `.execute(this.database)).rows[0];
    if(!fixture) throw new Error("workflow_test_fixture_missing_trader_customer_address_or_driver");
    await page.goto(`${baseUrl}/orders`,{waitUntil:"networkidle"});
    await page.getByRole("button",{name:/create order/i}).click();
    const dialog=page.getByRole("dialog",{name:/create order/i});
    await dialog.locator("#order-serial").fill(serial);
    await dialog.locator('[data-field="trader"] input').fill(fixture.traderName);
    await page.getByRole("option",{name:new RegExp(this.escape(fixture.traderName),"i")}).first().click();
    const customerInput=dialog.locator('[data-field="customer"] input');
    await customerInput.fill(fixture.customerName);
    await page.getByRole("option",{name:new RegExp(this.escape(fixture.customerName),"i")}).first().click();
    // Selecting an existing address lets the real form populate its dependent
    // Emirate/Area state. Then type a new synthetic Customer so no existing
    // Customer contact details are used by the test Order.
    await customerInput.fill(`Workflow Customer ${index+1}`);
    const mobile=dialog.locator("#order-mobile");
    await mobile.waitFor({state:"visible"});
    const runDigits=String(Number.parseInt(run.id.replaceAll("-","").slice(0,10),16)%10_000_000).padStart(7,"0");
    await mobile.fill(`000${runDigits.slice(0,6)}${index%10}`);
    await dialog.locator("#order-free").check();
    await dialog.locator("#order-free-reason").fill("Automated workflow test - side effects suppressed");
    const createResponsePromise=page.waitForResponse(response=>response.request().method()==="POST"&&/\/api\/v1\/operations\/orders$/.test(new URL(response.url()).pathname),{timeout:30000});
    await dialog.getByRole("button",{name:/^create order$/i}).click();
    let createResponse;
    try { createResponse=await createResponsePromise; }
    catch {
      const alerts=await dialog.locator('[role="alert"]').allTextContents();
      throw new Error(`workflow_test_order_form_did_not_submit:${alerts.filter(Boolean).join(" | ").slice(0,400)||"no_visible_validation_error"}`);
    }
    if(!createResponse.ok()) {
      const body=await createResponse.json().catch(()=>null) as {error?:{code?:string;message?:string}}|null;
      throw new Error(`workflow_test_order_create_rejected:http_${createResponse.status()}:${body?.error?.code??body?.error?.message??"unknown"}`);
    }
    await dialog.getByText(/order created/i).waitFor({state:"visible",timeout:30000});
    const order=(await sql<{id:string}>`select id from orders where company_id=${run.companyId}::uuid and serial_number=${serial} order by created_at desc limit 1`.execute(this.database)).rows[0];
    if(!order) throw new Error("workflow_test_created_order_not_found");
    await sql`update platform_workflow_test_scenarios set generated_order_id=${order.id}::uuid where id=${scenarioId}::uuid`.execute(this.database);
    await dialog.getByRole("button",{name:/done/i}).click();
    await this.advanceOrder(page,serial,fixture.driverName);
    const closed=(await sql<{status:string}>`select delivery_status status from orders where id=${order.id}::uuid`.execute(this.database)).rows[0];
    if(closed?.status!=="closed") throw new Error(`workflow_test_order_not_closed:${closed?.status??"missing"}`);
    return order.id;
  }

  private async advanceOrder(page:Page,serial:string,driverName:string):Promise<void> {
    await page.goto(new URL("/orders",page.url()).toString(),{waitUntil:"networkidle"});
    const serialSearch=page.getByPlaceholder("Serial No. only — press Enter",{exact:true});
    await serialSearch.fill(serial);
    await serialSearch.press("Enter");
    await page.waitForTimeout(400);
    const row=page.locator("tbody tr",{hasText:serial}).first();
    await row.getByRole("checkbox").check();
    await page.getByRole("button",{name:/assign driver/i}).first().click();
    const assignDialog=page.getByRole("dialog",{name:/assign driver/i});
    await assignDialog.getByRole("combobox").fill(driverName);
    await page.getByRole("option",{name:new RegExp(this.escape(driverName),"i")}).first().click();
    await assignDialog.getByRole("button",{name:/^assign driver$/i}).click();
    for(const action of [/out for delivery/i,/mark delivered|delivered/i,/close order/i]){
      await page.waitForTimeout(300);
      const refreshed=page.locator("tbody tr",{hasText:serial}).first();
      const direct=refreshed.getByRole("button",{name:action});
      if(await direct.count()) await direct.first().click();
      else {
        const more=refreshed.getByRole("button",{name:/more|actions/i});
        if(await more.count()) await more.click();
        await page.getByRole("menuitem",{name:action}).click();
      }
      const confirm=page.getByRole("button",{name:/confirm|save|apply|close order|mark delivered|out for delivery/i});
      if(await confirm.count()) await confirm.last().click();
    }
  }

  private async loadRun(id:string):Promise<Run|undefined>{return (await sql<Run>`select r.id,r.company_id "companyId",c.name_en "companyName",c.subdomain,r.planned_orders "plannedOrders",c.environment,c.workflow_testing_enabled_at "enabledAt" from platform_workflow_test_runs r join companies c on c.id=r.company_id where r.id=${id}::uuid and r.status='scheduled'`.execute(this.database)).rows[0];}
  private companyUrl(subdomain:string):string { const template=process.env["WORKFLOW_TEST_WEB_BASE_URL_TEMPLATE"]?.trim()||"http://{subdomain}app.localhost:5177"; if(!template.includes("{subdomain}")) throw new Error("workflow_test_web_url_template_invalid"); return template.replace("{subdomain}",subdomain).replace(/\/$/,""); }
  private async issueSession(companyId:string):Promise<{token:string;hash:string}> { const account=(await sql<{id:string}>`select a.id from accounts a where a.company_id=${companyId}::uuid and a.status='active' and a.account_kind='company_user' and exists(select 1 from account_roles ar join role_permissions rp on rp.role_id=ar.role_id where ar.account_id=a.id and rp.permission_code='users_roles.manage') order by a.created_at limit 1`.execute(this.database)).rows[0]; if(!account) throw new Error("workflow_test_company_admin_missing"); const token=this.tokens.create(); await sql`insert into account_sessions(id,account_id,company_id,token_hash,expires_at,user_agent) values(${randomUUID()}::uuid,${account.id}::uuid,${companyId}::uuid,${token.hash},now()+interval '30 minutes','Tawseelhub workflow browser worker')`.execute(this.database); return token; }
  private async revokeSession(hash:string):Promise<void>{await sql`update account_sessions set revoked_at=coalesce(revoked_at,now()) where token_hash=${hash}`.execute(this.database);}
  private escape(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
}
