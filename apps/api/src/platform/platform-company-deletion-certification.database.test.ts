import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configuration, type AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  type CompanyDeletionFailureInjector,
  type CompanyDeletionStage,
  PlatformCompanyDeletionExecutionService,
} from "./platform-company-deletion-execution.service.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";
import { checksumFileSha256 } from "./platform-company-deletion-backup.service.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
const enabled = process.env.RUN_COMPANY_DELETION_CERTIFICATION === "true";
const stages: CompanyDeletionStage[] = [
  "guards_disabled", "cycles_prepared", "operational_deleted", "accounting_deleted",
  "journals_deleted", "financial_deleted", "identities_deleted", "storefront_deleted",
  "communications_deleted", "references_verified", "guards_restored", "company_deleted",
];

class EmptyStorage extends FileStoragePort {
  public async storePrivate(): Promise<{ storageKey: string }> { throw new Error("unused"); }
  public async readPrivate(): Promise<Uint8Array> { throw new Error("unused"); }
  public async deletePrivate(): Promise<void> {}
  public async storeCommerce(): Promise<{ storageKey: string }> { throw new Error("unused"); }
  public async readCommerce(): Promise<Uint8Array> { throw new Error("unused"); }
  public async deleteCommerce(): Promise<void> {}
}

class FlakyStorage extends EmptyStorage {
  public attempts = 0;
  public override async deletePrivate(): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("injected storage failure");
  }
}

interface Prepared {
  companyId: string;
  code: string;
  operationId: string;
  previewId: string;
  key: string;
  commerceId?: string;
}

describe.skipIf(!enabled)("permanent Company deletion final certification", () => {
  let database: Kysely<DatabaseSchema>;
  let configService: ConfigService<AppConfiguration, true>;
  let actorId: string;
  let backupName: string;
  let backupSize: number;
  let backupChecksum: string;

  beforeAll(async () => {
    const settings = configuration();
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: settings.database.url, max: 8 }) }) });
    configService = new ConfigService<AppConfiguration, true>(settings);
    actorId = (await sql<{ id: string }>`select id from accounts where company_id is null order by created_at limit 1`.execute(database)).rows[0]!.id;
    backupName = "company-deletion-certification.dump";
    await mkdir(settings.companyDeletion.backupRoot, { recursive: true });
    await writeFile(resolve(settings.companyDeletion.backupRoot, backupName), "certification-artifact", { flag: "w" });
    backupSize = (await stat(resolve(settings.companyDeletion.backupRoot, backupName))).size;
    backupChecksum = await checksumFileSha256(resolve(settings.companyDeletion.backupRoot, backupName));
    const stale = (await sql<{ id: string; code: string }>`select id,code from companies where code like 'DEV-CERT-%'`.execute(database)).rows;
    for (const company of stale) {
      await sql`update companies set status='closed',closed_at=now() where id=${company.id}::uuid`.execute(database);
      await sql`update platform_company_deletion_operations set state='rolled_back',failure_reason='Superseded certification fixture cleanup' where company_id_snapshot=${company.id}::uuid and state in ('previewed','ready','deleting')`.execute(database);
      const key = randomUUID();
      const preview = await new PlatformCompanyDeletionService(database).preview(company.id, { accountId: actorId, correlationId: randomUUID() }, key);
      await sql`insert into platform_company_deletion_backups(operation_id,company_id_snapshot,backup_type,status,storage_reference,checksum_sha256,size_bytes,verified_at,completed_at,created_by_account_id) values(${String(preview.operationId)}::uuid,${company.id}::uuid,'full_database','verified',${backupName},${backupChecksum},${backupSize},now(),now(),${actorId}::uuid)`.execute(database);
      await sql`update platform_company_deletion_operations set state='ready',backup_reference=${backupName} where id=${String(preview.operationId)}::uuid`.execute(database);
      await sql`update platform_company_deletion_previews set ready_for_delete=true where id=${String(preview.previewId)}::uuid`.execute(database);
      await execution().execute(company.id, { operationId: String(preview.operationId), previewId: String(preview.previewId), confirmation: `DELETE ${company.code}`, idempotencyKey: key });
    }
  }, 300_000);

  afterAll(async () => database.destroy(), 30_000);

  async function seedRich(label: string, includeGapFixtures = false): Promise<{ companyId: string; code: string; commerceId?: string }> {
    const companyId = randomUUID();
    const suffix = companyId.slice(0, 8);
    const code = `DEV-CERT-${label}-${suffix}`.toUpperCase();
    const account = randomUUID(); const role = randomUUID(); const area = randomUUID();
    const trader = randomUUID(); const customer = randomUUID(); const driver = randomUUID();
    const employee = randomUUID(); const order = randomUUID(); const conversation = randomUUID();
    const message = randomUUID(); const event = randomUUID(); const journal = randomUUID();
    const fiscal = randomUUID(); const period = randomUUID();
    const reconciliation = randomUUID(); const settlement = randomUUID();
    const emirate = (await sql<{ id: string }>`select id from emirates limit 1`.execute(database)).rows[0]!.id;
    await sql`insert into companies(id,code,subdomain,name_en,status,environment,activated_at) values(${companyId}::uuid,${code},${`dev-cert-${suffix}`},${`Certification ${label}`},'active','development',now())`.execute(database);
    await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,status) values(${account}::uuid,${companyId}::uuid,'company_user',${`cert-${suffix}`},${`cert-${suffix}`},'x','disabled')`.execute(database);
    await sql`insert into company_users(company_id,account_id,name_en,display_name,is_active) values(${companyId}::uuid,${account}::uuid,'Certification Admin','Certification Admin',false)`.execute(database);
    await sql`insert into roles(id,company_id,code,name,is_active) values(${role}::uuid,${companyId}::uuid,'administrator','Administrator',false)`.execute(database);
    await sql`insert into role_permissions(role_id,permission_code) select ${role}::uuid,code from permissions limit 1`.execute(database);
    await sql`insert into account_roles(account_id,role_id,company_id) values(${account}::uuid,${role}::uuid,${companyId}::uuid)`.execute(database);
    await sql`insert into file_objects(company_id,owner_type,storage_provider,storage_key,original_filename,media_type,size_bytes,scan_status) values(${companyId}::uuid,'company','local',${`logos/${companyId}/certification`},'certification.txt','text/plain',1,'clean')`.execute(database);
    await sql`insert into areas(id,company_id,code,name_en,emirate_id) values(${area}::uuid,${companyId}::uuid,${`A-${suffix}`},'Area',${emirate}::uuid)`.execute(database);
    await sql`insert into chart_of_accounts(id,company_id,code,name_en,account_type,account_class,normal_balance) values(${randomUUID()}::uuid,${companyId}::uuid,${`1000-${suffix}`},'Cash','asset','cash','debit')`.execute(database);
    await sql`insert into fiscal_years(id,company_id,fiscal_year_code,name,start_date,end_date,status) values(${fiscal}::uuid,${companyId}::uuid,${`FY-${suffix}`},'FY','2026-01-01','2026-12-31','open')`.execute(database);
    await sql`insert into accounting_periods(id,company_id,period_start,period_end,fiscal_year_id,period_number,period_code,name,status) values(${period}::uuid,${companyId}::uuid,'2026-01-01','2026-01-31',${fiscal}::uuid,1,${`P-${suffix}`},'Jan','open')`.execute(database);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number) values(${trader}::uuid,${companyId}::uuid,${`T-${suffix}`},'Trader','971500000001')`.execute(database);
    await sql`insert into customers(id,company_id,code,name,mobile_number,created_by_account_id) values(${customer}::uuid,${companyId}::uuid,${`C-${suffix}`},'Customer','971500000002',${account}::uuid)`.execute(database);
    await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order) values(${driver}::uuid,${companyId}::uuid,${`D-${suffix}`},'Driver','971500000003','outsourced',5)`.execute(database);
    await sql`insert into employees(id,company_id,employee_number,name_en) values(${employee}::uuid,${companyId}::uuid,${`E-${suffix}`},'Employee')`.execute(database);
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,payment_condition,final_service_fee_snapshot,customer_provenance_status,pricing_provenance_status,service_fee) values(${order}::uuid,${companyId}::uuid,${`ORD-${suffix}`},'2026-01-15',${trader}::uuid,${area}::uuid,${account}::uuid,'Someone','971500000004','Address',1,'customer_pays_cod_and_fee',25,'legacy_unattributed','legacy_unattributed',25)`.execute(database);
    await sql`insert into order_status_history(id,company_id,order_id,status_dimension,to_status,changed_by_account_id) values(${randomUUID()}::uuid,${companyId}::uuid,${order}::uuid,'delivery','new',${account}::uuid)`.execute(database);
    await sql`insert into conversations(id,company_id,conversation_type,participant_context_type,created_by_account_id) values(${conversation}::uuid,${companyId}::uuid,'general_support','trader',${account}::uuid)`.execute(database);
    await sql`insert into messages(id,company_id,conversation_id,sender_role,message_type,conversation_sequence,text_body) values(${message}::uuid,${companyId}::uuid,${conversation}::uuid,'office','text',1,'hello')`.execute(database);
    await sql`update conversations set last_message_id=${message}::uuid where id=${conversation}::uuid`.execute(database);
    await sql`insert into accounting_events(id,company_id,event_type,event_version,source_entity_type,source_entity_id,effective_accounting_date,correlation_id,idempotency_key,event_hash,actor_type,description) values(${event}::uuid,${companyId}::uuid,'order_delivered',1,'order',${order}::uuid,'2026-01-15',${`corr-${suffix}`},${`corr-${suffix}`},${`corr-${suffix}`},'system','x')`.execute(database);
    await sql`insert into journal_entries(id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,source_type,description,created_by_account_id,accounting_event_id) values(${journal}::uuid,${companyId}::uuid,${`JE-${suffix}`},${period}::uuid,${fiscal}::uuid,'2026-01-15','order','x',${account}::uuid,${event}::uuid)`.execute(database);
    await sql`update accounting_events set journal_id=${journal}::uuid where id=${event}::uuid`.execute(database);
    let commerceId: string | undefined;
    if (includeGapFixtures) {
      await sql`insert into driver_reconciliations(id,company_id,reconciliation_number,driver_id,business_date,gross_collections,driver_payable_deduction,reconciliation_expenses,net_amount_received,created_by_account_id) values(${reconciliation}::uuid,${companyId}::uuid,${`REC-${suffix}`},${driver}::uuid,current_date,0,0,0,0,${account}::uuid)`.execute(database);
      await sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,gross_payable,service_fee_deductions,other_deductions,charges,adjustments,net_payable,created_by_account_id) values(${settlement}::uuid,${companyId}::uuid,${`SET-${suffix}`},${trader}::uuid,current_date,0,0,0,0,0,0,${account}::uuid)`.execute(database);
      commerceId = randomUUID();
      const storefront = randomUUID(); const storeCategory = randomUUID(); const product = randomUUID();
      const marketplaceCategory = (await sql<{ id: string }>`select id from marketplace_categories order by display_order,id limit 1`.execute(database)).rows[0]?.id;
      if (marketplaceCategory === undefined) throw new Error("Marketplace taxonomy is required for certification");
      await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values(${commerceId}::uuid,${`Certification Shop ${suffix}`},'trader_self_registered','approved')`.execute(database);
      await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source) values(${commerceId}::uuid,${companyId}::uuid,${trader}::uuid,'migration_backfill')`.execute(database);
      await sql`insert into trader_storefronts(id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at) values(${storefront}::uuid,${commerceId}::uuid,'Certification Shop',${`cert-shop-${suffix}`},'general','modern','published',now())`.execute(database);
      await sql`insert into trader_storefront_categories(id,storefront_id,name_en,slug) values(${storeCategory}::uuid,${storefront}::uuid,'Certification','certification')`.execute(database);
      await sql`insert into trader_storefront_products(id,storefront_id,category_id,name,slug,product_code,selling_price,lifecycle_status) values(${product}::uuid,${storefront}::uuid,${storeCategory}::uuid,'Certification Product','certification-product','CERT-1',1,'active')`.execute(database);
      await sql`insert into storefront_marketplace_categories(storefront_id,marketplace_category_id) values(${storefront}::uuid,${marketplaceCategory}::uuid)`.execute(database);
    }
    await sql`update companies set status='closed',closed_at=now() where id=${companyId}::uuid`.execute(database);
    return { companyId, code, ...(commerceId === undefined ? {} : { commerceId }) };
  }

  async function prepare(label: string, includeGapFixtures = false): Promise<Prepared> {
    const fixture = await seedRich(label, includeGapFixtures);
    const key = randomUUID();
    const preview = await new PlatformCompanyDeletionService(database).preview(fixture.companyId, { accountId: actorId, correlationId: randomUUID() }, key);
    expect(preview.blockers).toEqual([]);
    await sql`insert into platform_company_deletion_backups(operation_id,company_id_snapshot,backup_type,status,storage_reference,checksum_sha256,size_bytes,verified_at,completed_at,created_by_account_id) values(${String(preview.operationId)}::uuid,${fixture.companyId}::uuid,'full_database','verified',${backupName},${backupChecksum},${backupSize},now(),now(),${actorId}::uuid)`.execute(database);
    await sql`update platform_company_deletion_operations set state='ready',backup_reference=${backupName} where id=${String(preview.operationId)}::uuid`.execute(database);
    await sql`update platform_company_deletion_previews set ready_for_delete=true where id=${String(preview.previewId)}::uuid`.execute(database);
    return { ...fixture, operationId: String(preview.operationId), previewId: String(preview.previewId), key };
  }

  async function prepareProduction(label: string, elapsedSeconds: number): Promise<Prepared> {
    const fixture = await seedRich(label);
    await sql`update companies set environment='production',closed_at=clock_timestamp()-(${elapsedSeconds} * interval '1 second') where id=${fixture.companyId}::uuid`.execute(database);
    const key = randomUUID();
    const preview = await new PlatformCompanyDeletionService(database).preview(fixture.companyId, { accountId: actorId, correlationId: randomUUID() }, key);
    await sql`insert into platform_company_deletion_backups(operation_id,company_id_snapshot,backup_type,status,storage_reference,checksum_sha256,size_bytes,verified_at,completed_at,created_by_account_id) values(${String(preview.operationId)}::uuid,${fixture.companyId}::uuid,'full_database','verified',${backupName},${backupChecksum},${backupSize},now(),now(),${actorId}::uuid)`.execute(database);
    await sql`update platform_company_deletion_operations set state='ready',backup_reference=${backupName} where id=${String(preview.operationId)}::uuid`.execute(database);
    await sql`update platform_company_deletion_previews set ready_for_delete=true,blockers='[]'::jsonb where id=${String(preview.previewId)}::uuid`.execute(database);
    return { ...fixture, operationId: String(preview.operationId), previewId: String(preview.previewId), key };
  }

  async function fingerprint(companyId: string): Promise<Record<string, number>> {
    const tables = ["accounts","company_users","roles","orders","customers","traders","drivers","employees","accounting_events","journal_entries","conversations","messages","chart_of_accounts","file_objects"];
    const result: Record<string, number> = {};
    for (const table of tables) result[table] = Number((await sql<{ n: string }>`select count(*)::bigint n from ${sql.table(table)} where company_id=${companyId}::uuid`.execute(database)).rows[0]!.n);
    result.company = Number((await sql<{ n: string }>`select count(*)::bigint n from companies where id=${companyId}::uuid`.execute(database)).rows[0]!.n);
    return result;
  }

  function execution(injector: CompanyDeletionFailureInjector = () => undefined): PlatformCompanyDeletionExecutionService {
    return new PlatformCompanyDeletionExecutionService(database, configService, new EmptyStorage(), injector);
  }

  async function removeAfterRollback(fixture: Prepared): Promise<void> {
    const current = (await sql<{ state: string }>`select state from platform_company_deletion_operations where id=${fixture.operationId}::uuid`.execute(database)).rows[0]?.state;
    if (current === "ready") {
      await execution().execute(fixture.companyId, { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key });
      return;
    }
    const next = await new PlatformCompanyDeletionService(database).preview(fixture.companyId, { accountId: actorId, correlationId: randomUUID() }, randomUUID());
    const key = (await sql<{ key: string }>`select idempotency_key key from platform_company_deletion_operations where id=${String(next.operationId)}::uuid`.execute(database)).rows[0]!.key;
    await sql`insert into platform_company_deletion_backups(operation_id,company_id_snapshot,backup_type,status,storage_reference,checksum_sha256,size_bytes,verified_at,completed_at,created_by_account_id) values(${String(next.operationId)}::uuid,${fixture.companyId}::uuid,'full_database','verified',${backupName},${backupChecksum},${backupSize},now(),now(),${actorId}::uuid)`.execute(database);
    await sql`update platform_company_deletion_operations set state='ready',backup_reference=${backupName} where id=${String(next.operationId)}::uuid`.execute(database);
    await sql`update platform_company_deletion_previews set ready_for_delete=true where id=${String(next.previewId)}::uuid`.execute(database);
    await execution().execute(fixture.companyId, { operationId: String(next.operationId), previewId: String(next.previewId), confirmation: `DELETE ${fixture.code}`, idempotencyKey: key });
  }

  it.each(stages)("rolls back the complete rich fingerprint when %s fails", async (stage) => {
    const fixture = await prepare(stage.slice(0, 8));
    const before = await fingerprint(fixture.companyId);
    await expect(execution((current) => { if (current === stage) throw new Error(`injected:${stage}`); }).execute(fixture.companyId, { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key })).rejects.toThrow(`injected:${stage}`);
    expect(await fingerprint(fixture.companyId)).toEqual(before);
    expect((await sql<{ status: string }>`select status from companies where id=${fixture.companyId}::uuid`.execute(database)).rows[0]?.status).toBe("closed");
    expect(Number((await sql<{ n: string }>`select count(*)::text n from pg_trigger where not tgisinternal and tgenabled<>'O'`.execute(database)).rows[0]!.n)).toBe(0);
    expect((await sql<{ state: string }>`select state from platform_company_deletion_operations where id=${fixture.operationId}::uuid`.execute(database)).rows[0]?.state).toBe("rolled_back");
    await removeAfterRollback(fixture);
  }, 120_000);

  it("rejects cross-Company operation, preview, and confirmation mismatches without changing either Company", async () => {
    const a = await prepare("crossa"); const b = await prepare("crossb");
    const beforeA = await fingerprint(a.companyId); const beforeB = await fingerprint(b.companyId);
    await expect(execution().execute(a.companyId, { operationId: b.operationId, previewId: b.previewId, confirmation: `DELETE ${b.code}`, idempotencyKey: b.key })).rejects.toThrow();
    await expect(execution().execute(a.companyId, { operationId: a.operationId, previewId: b.previewId, confirmation: `DELETE ${a.code}`, idempotencyKey: a.key })).rejects.toThrow();
    await expect(execution().execute(a.companyId, { operationId: a.operationId, previewId: a.previewId, confirmation: `DELETE ${b.code}`, idempotencyKey: a.key })).rejects.toThrow();
    expect(await fingerprint(a.companyId)).toEqual(beforeA); expect(await fingerprint(b.companyId)).toEqual(beforeB);
    await removeAfterRollback(a); await removeAfterRollback(b);
  }, 180_000);

  it("allows only one of two concurrent executions to delete the Company", async () => {
    const fixture = await prepare("concur");
    const request = { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key };
    const outcomes = await Promise.allSettled([execution().execute(fixture.companyId, request), execution().execute(fixture.companyId, request)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await sql`select 1 from companies where id=${fixture.companyId}::uuid`.execute(database)).rows).toHaveLength(0);
    expect(Number((await sql<{ n: string }>`select count(*)::text n from platform_company_deletion_operations where id=${fixture.operationId}::uuid and state='completed'`.execute(database)).rows[0]!.n)).toBe(1);
  }, 120_000);

  it("returns a stable result for the same completed operation and rejects a second active key", async () => {
    const fixture = await prepare("idem");
    await expect(new PlatformCompanyDeletionService(database).preview(fixture.companyId, { accountId: actorId, correlationId: randomUUID() }, randomUUID())).rejects.toThrow();
    const request = { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key };
    await execution().execute(fixture.companyId, request);
    await expect(execution().execute(fixture.companyId, request)).resolves.toMatchObject({ alreadyCompleted: true, state: "completed" });
    expect(Number((await sql<{ n: string }>`select count(*)::text n from platform_company_deletion_operations where id=${fixture.operationId}::uuid`.execute(database)).rows[0]!.n)).toBe(1);
  }, 120_000);

  it("deletes nonzero reconciliation, settlement, and Company-Commerce links while preserving global Storefront rows", async () => {
    const fixture = await prepare("gaps", true);
    const before = {
      reconciliations: Number((await sql<{ n: string }>`select count(*)::text n from driver_reconciliations where company_id=${fixture.companyId}::uuid`.execute(database)).rows[0]!.n),
      settlements: Number((await sql<{ n: string }>`select count(*)::text n from trader_settlements where company_id=${fixture.companyId}::uuid`.execute(database)).rows[0]!.n),
      companyCommerceLinks: Number((await sql<{ n: string }>`select count(*)::text n from trader_commerce_company_links where company_id=${fixture.companyId}::uuid`.execute(database)).rows[0]!.n),
      storefronts: Number((await sql<{ n: string }>`select count(*)::text n from trader_storefronts where trader_commerce_id=${fixture.commerceId!}::uuid`.execute(database)).rows[0]!.n),
      products: Number((await sql<{ n: string }>`select count(*)::text n from trader_storefront_products product join trader_storefronts storefront on storefront.id=product.storefront_id where storefront.trader_commerce_id=${fixture.commerceId!}::uuid`.execute(database)).rows[0]!.n),
      marketplaceLinks: Number((await sql<{ n: string }>`select count(*)::text n from storefront_marketplace_categories link join trader_storefronts storefront on storefront.id=link.storefront_id where storefront.trader_commerce_id=${fixture.commerceId!}::uuid`.execute(database)).rows[0]!.n),
    };
    expect(before).toMatchObject({
      reconciliations: 1,
      settlements: 1,
      companyCommerceLinks: 1,
      storefronts: 1,
      products: 1,
      marketplaceLinks: 1,
    });
    const globalBefore = (await sql<{ categories: string; profiles: string }>`select (select count(*)::text from marketplace_categories) categories,(select count(*)::text from trader_commerce_profiles) profiles`.execute(database)).rows[0]!;
    await execution().execute(fixture.companyId, { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key });
    for (const table of ["driver_reconciliations","trader_settlements","trader_commerce_company_links"] as const) {
      expect(Number((await sql<{ n: string }>`select count(*)::text n from ${sql.table(table)} where company_id=${fixture.companyId}::uuid`.execute(database)).rows[0]!.n)).toBe(0);
    }
    expect((await sql`select 1 from trader_storefronts where trader_commerce_id=${fixture.commerceId!}::uuid`.execute(database)).rows).toHaveLength(1);
    expect((await sql`select 1 from storefront_marketplace_categories link join trader_storefronts storefront on storefront.id=link.storefront_id where storefront.trader_commerce_id=${fixture.commerceId!}::uuid`.execute(database)).rows).toHaveLength(1);
    const globalAfter = (await sql<{ categories: string; profiles: string }>`select (select count(*)::text from marketplace_categories) categories,(select count(*)::text from trader_commerce_profiles) profiles`.execute(database)).rows[0]!;
    expect(globalAfter).toEqual(globalBefore);
    if (fixture.commerceId !== undefined) {
      await sql`delete from storefront_marketplace_categories using trader_storefronts where storefront_marketplace_categories.storefront_id=trader_storefronts.id and trader_storefronts.trader_commerce_id=${fixture.commerceId}::uuid`.execute(database);
      await sql`delete from trader_storefront_products using trader_storefronts where trader_storefront_products.storefront_id=trader_storefronts.id and trader_storefronts.trader_commerce_id=${fixture.commerceId}::uuid`.execute(database);
      await sql`delete from trader_storefront_categories using trader_storefronts where trader_storefront_categories.storefront_id=trader_storefronts.id and trader_storefronts.trader_commerce_id=${fixture.commerceId}::uuid`.execute(database);
      await sql`delete from trader_storefronts where trader_commerce_id=${fixture.commerceId}::uuid`.execute(database);
      await sql`delete from trader_commerce_profiles where id=${fixture.commerceId}::uuid`.execute(database);
    }
  }, 180_000);

  it("keeps database deletion committed while failed external cleanup retries idempotently", async () => {
    const fixture = await prepare("cleanup");
    const storage = new FlakyStorage();
    const service = new PlatformCompanyDeletionExecutionService(database, configService, storage, () => undefined);
    await service.execute(fixture.companyId, { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key });
    expect((await sql`select 1 from companies where id=${fixture.companyId}::uuid`.execute(database)).rows).toHaveLength(0);
    expect((await sql<{ state: string }>`select state from platform_company_deletion_operations where id=${fixture.operationId}::uuid`.execute(database)).rows[0]?.state).toBe("completed_cleanup_pending");
    expect((await service.retryCleanup(fixture.operationId)).state).toBe("completed");
    expect((await service.retryCleanup(fixture.operationId)).failed).toBe(0);
    expect(storage.attempts).toBe(2);
  }, 120_000);

  it("rejects stale preview row-count drift before destructive work", async () => {
    const fixture = await prepare("stale");
    await sql`insert into audit_events(id,company_id,action,subject_type,correlation_id) values(${randomUUID()}::uuid,${fixture.companyId}::uuid,'certification.drift','test',${randomUUID()})`.execute(database);
    await expect(execution().execute(fixture.companyId, { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key })).rejects.toThrow("Company data changed after preview");
    expect((await sql`select 1 from companies where id=${fixture.companyId}::uuid`.execute(database)).rows).toHaveLength(1);
    await removeAfterRollback(fixture);
  }, 120_000);

  it("rejects a checksum mismatch and a cross-Company backup binding", async () => {
    const checksumFixture = await prepare("checksum");
    await sql`update platform_company_deletion_backups set checksum_sha256=${"f".repeat(64)} where operation_id=${checksumFixture.operationId}::uuid`.execute(database);
    await expect(execution().execute(checksumFixture.companyId, { operationId: checksumFixture.operationId, previewId: checksumFixture.previewId, confirmation: `DELETE ${checksumFixture.code}`, idempotencyKey: checksumFixture.key })).rejects.toThrow("checksum");
    await removeAfterRollback(checksumFixture);

    const bindingFixture = await prepare("binding");
    const otherCompany = randomUUID();
    await sql`update platform_company_deletion_backups set company_id_snapshot=${otherCompany}::uuid where operation_id=${bindingFixture.operationId}::uuid`.execute(database);
    await expect(execution().execute(bindingFixture.companyId, { operationId: bindingFixture.operationId, previewId: bindingFixture.previewId, confirmation: `DELETE ${bindingFixture.code}`, idempotencyKey: bindingFixture.key })).rejects.toThrow("another Company");
    await removeAfterRollback(bindingFixture);
  }, 180_000);

  it.each([
    ["0h", 0, false],
    ["1h", 60 * 60, false],
    ["47h59m", (47 * 60 + 59) * 60, false],
    ["48h", 48 * 60 * 60, true],
    ["49h", 49 * 60 * 60, true],
  ] as const)("enforces Production final execution at %s", async (label, elapsedSeconds, allowed) => {
    const fixture = await prepareProduction(`prod-${label}`, elapsedSeconds);
    const before = await fingerprint(fixture.companyId);
    const request = { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key };
    if (allowed) {
      await expect(execution().execute(fixture.companyId, request)).resolves.toMatchObject({ state: "completed_cleanup_pending" });
      expect((await sql`select 1 from companies where id=${fixture.companyId}::uuid`.execute(database)).rows).toHaveLength(0);
      expect((await sql<{ state: string }>`select state from platform_company_deletion_operations where id=${fixture.operationId}::uuid`.execute(database)).rows[0]?.state).toBe("completed");
    } else {
      await expect(execution().execute(fixture.companyId, request)).rejects.toThrow("48 continuous hours");
      expect(await fingerprint(fixture.companyId)).toEqual(before);
      await sql`update companies set environment='development',status='closed',closed_at=now() where id=${fixture.companyId}::uuid`.execute(database);
      await removeAfterRollback(fixture);
    }
  }, 180_000);

  it("denies final execution after a long suspension because only Closed starts eligibility", async () => {
    const fixture = await prepare("suspended-prod");
    await sql`update companies set status='suspended',closed_at=null,environment='production' where id=${fixture.companyId}::uuid`.execute(database);
    await expect(execution().execute(fixture.companyId, { operationId: fixture.operationId, previewId: fixture.previewId, confirmation: `DELETE ${fixture.code}`, idempotencyKey: fixture.key })).rejects.toThrow();
    expect((await sql<{ status: string }>`select status from companies where id=${fixture.companyId}::uuid`.execute(database)).rows[0]?.status).toBe("suspended");
    await sql`update companies set environment='development',status='closed',closed_at=now() where id=${fixture.companyId}::uuid`.execute(database);
    await removeAfterRollback(fixture);
  }, 180_000);
});
