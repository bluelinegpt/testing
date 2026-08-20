import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { CommerceProviderRouter } from "./commerce-provider.router.js";
import type { CommerceWebhookHeaders, NormalizedCommerceEvent, NormalizedCommerceOrder } from "./commerce-integration.types.js";
import { signMockCommercePayload } from "./mock-commerce.provider.js";
import { normalizeShopifyShopDomain, verifyShopifyCallbackHmac } from "./shopify-commerce.provider.js";
import type { CommerceAreaMappingDto, CreateMockCommerceConnectionDto, CreateTraderMockCommerceConnectionDto, DisconnectCommerceConnectionDto, SimulateCommerceEventDto, StartSallaConnectionDto, StartShopifyConnectionDto, StartTraderSallaConnectionDto, StartTraderShopifyConnectionDto } from "./commerce-integration.dto.js";

const mapRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase()), value]));
const ref = async (db: Kysely<DatabaseSchema>, sequence: string, prefix: string) => {
  const row = (await sql<{ n: string }>`select nextval(${sql.raw(`'${sequence}'`)})::text n`.execute(db)).rows[0];
  return `${prefix}-${String(row?.n ?? "0").padStart(6, "0")}`;
};
const normalizeIdentifier = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
const normalizeMobile = (value: string) => value.replace(/[^\d]/g, "").replace(/^05/, "9715");
const sanitizePayload = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => /secret|token|key|signature|password/i.test(key) ? "[redacted]" : item)) as Record<string, unknown>;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
type CommerceEventTerminalStatus = "succeeded" | "duplicate";
type TraderCommerceContext = {
  readonly companyId: string;
  readonly traderCommerceId: string;
  readonly traderId: string;
};
const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
const sallaScopes = "orders.read orders.write webhooks.read_write offline_access";
const shopifyScopes = "read_orders,read_fulfillments,write_fulfillments";
const shopifyApiVersion = () => process.env.SHOPIFY_ADMIN_API_VERSION?.trim() || "2026-07";

@Injectable()
export class CommerceIntegrationService {
  public constructor(
    @Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identity: IdentityContextAccessor,
    @Inject(CommerceProviderRouter) private readonly providers: CommerceProviderRouter,
  ) {}

  public providerInventory() {
    return { items: this.providers.list() };
  }

  public traderProviderInventory() {
    const includeMockProvider = process.env.NODE_ENV !== "production";
    return {
      items: [
        ...this.providers.list().filter((provider) => includeMockProvider || provider.key !== "mock_commerce"),
        { key: "woocommerce", label: "WooCommerce", enabled: false, capabilities: [] },
      ],
    };
  }

  public async mockTargets() {
    const rows = await sql<Record<string, unknown>>`
      select c.id company_id,c.name_en company_name,t.id trader_id,t.name_en trader_name,link.trader_commerce_id
      from trader_commerce_company_links link
      join companies c on c.id=link.company_id
      join traders t on t.id=link.trader_id and t.company_id=link.company_id
      where link.status='active' and t.account_status='active' and c.status <> 'closed'
      order by c.name_en,t.name_en
      limit 100
    `.execute(this.db);
    return { items: rows.rows.map(mapRow) };
  }

  public async createMockConnection(input: CreateMockCommerceConnectionDto) {
    this.providers.get("mock_commerce");
    const actor = this.identity.current().identityId;
    const link = (await sql<Record<string, unknown>>`
      select trader_commerce_id from trader_commerce_company_links
      where company_id=${input.companyId}::uuid and trader_id=${input.traderId}::uuid and status='active'
        and (${input.traderCommerceId ?? null}::uuid is null or trader_commerce_id=${input.traderCommerceId ?? null}::uuid)
    `.execute(this.db)).rows[0];
    if (!link) throw new BadRequestException("trader_commerce_link_not_found");
    const reference = await ref(this.db, "commerce_integration_connection_reference_seq", "CIN");
    const storeId = input.externalStoreId?.trim() || `mock-store-${randomUUID()}`;
    const provider = this.providers.get("mock_commerce");
    const inserted = await sql<Record<string, unknown>>`
      insert into commerce_integration_connections(reference_number,company_id,trader_id,trader_commerce_id,provider,external_store_id,external_store_name,status,connection_mode,health_status,capabilities,connected_at,created_by_account_id)
      values(${reference},${input.companyId}::uuid,${input.traderId}::uuid,${String(link.trader_commerce_id)}::uuid,'mock_commerce',${storeId},${input.externalStoreName.trim()},'connected',${input.connectionMode ?? "bidirectional"},'healthy',${JSON.stringify(provider.capabilities())}::jsonb,now(),${actor}::uuid)
      returning *
    `.execute(this.db);
    await sql`
      insert into commerce_integration_credentials(connection_id,credential_kind,secret_reference,status,created_by_account_id)
      values(${inserted.rows[0]!.id}::uuid,'mock_signature','mock-secret-reference','configured',${actor}::uuid)
    `.execute(this.db);
    return this.connection(String(inserted.rows[0]!.id));
  }

  public async createTraderMockConnection(input: CreateTraderMockCommerceConnectionDto) {
    const context = await this.currentTraderContext(input.traderCommerceId);
    return this.createMockConnection({
      companyId: context.companyId,
      traderId: context.traderId,
      traderCommerceId: context.traderCommerceId,
      externalStoreName: input.externalStoreName,
      connectionMode: input.connectionMode ?? "bidirectional",
      ...(input.externalStoreId ? { externalStoreId: input.externalStoreId } : {}),
    });
  }

  public async startSallaConnection(input: StartSallaConnectionDto) {
    this.providers.get("salla");
    const clientId = process.env.SALLA_CLIENT_ID?.trim();
    const redirectUri = process.env.SALLA_REDIRECT_URI?.trim();
    if (!clientId || !redirectUri) throw new BadRequestException("salla_oauth_not_configured");
    const actor = this.identity.current().identityId;
    const link = (await sql<Record<string, unknown>>`
      select trader_commerce_id from trader_commerce_company_links
      where company_id=${input.companyId}::uuid and trader_id=${input.traderId}::uuid and trader_commerce_id=${input.traderCommerceId}::uuid and status='active'
    `.execute(this.db)).rows[0];
    if (!link) throw new BadRequestException("trader_commerce_link_not_found");
    const state = randomBytes(32).toString("base64url");
    await sql`
      insert into commerce_integration_oauth_states(provider,state_hash,company_id,trader_id,trader_commerce_id,requested_by_account_id,redirect_after,expires_at)
      values('salla',${hashSecret(state)},${input.companyId}::uuid,${input.traderId}::uuid,${input.traderCommerceId}::uuid,${actor}::uuid,${input.redirectAfter ?? null},now()+interval '10 minutes')
    `.execute(this.db);
    const url = new URL("https://accounts.salla.sa/oauth2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", sallaScopes);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), expiresInSeconds: 600, provider: "salla" };
  }

  public async startTraderSallaConnection(input: StartTraderSallaConnectionDto) {
    const context = await this.currentTraderContext(input.traderCommerceId);
    return this.startSallaConnection({
      companyId: context.companyId,
      traderId: context.traderId,
      traderCommerceId: context.traderCommerceId,
      redirectAfter: input.redirectAfter ?? "/integrations",
    });
  }

  public async completeSallaCallback(query: Record<string, string | undefined>) {
    if (query.error) return { status: "cancelled", message: "Salla connection was not completed." };
    if (!query.code || !query.state) throw new BadRequestException("salla_oauth_callback_invalid");
    const stateHash = hashSecret(query.state);
    const state = (await sql<Record<string, unknown>>`
      update commerce_integration_oauth_states
      set status='consumed',consumed_at=now()
      where provider='salla' and state_hash=${stateHash} and status='pending' and expires_at > now()
      returning *
    `.execute(this.db)).rows[0];
    if (!state) throw new BadRequestException("salla_oauth_state_invalid");
    const token = await this.exchangeSallaCode(query.code);
    const store = await this.fetchSallaStoreIdentity(token.accessToken);
    const provider = this.providers.get("salla");
    const reference = await ref(this.db, "commerce_integration_connection_reference_seq", "CIN");
    const storeId = store.id || `salla-${randomUUID()}`;
    const inserted = await sql<Record<string, unknown>>`
      insert into commerce_integration_connections(reference_number,company_id,trader_id,trader_commerce_id,provider,external_store_id,external_store_name,status,connection_mode,health_status,capabilities,sync_cursor,connected_at,created_by_account_id)
      values(${reference},${String(state.company_id)}::uuid,${String(state.trader_id)}::uuid,${String(state.trader_commerce_id)}::uuid,'salla',${storeId},${store.name || "Salla Store"},'connected','bidirectional','healthy',${JSON.stringify(provider.capabilities())}::jsonb,${JSON.stringify({ sallaStore: store.safeMetadata, oauthScope: token.scope, tokenExpiresAt: token.expiresAt })}::jsonb,now(),${String(state.requested_by_account_id)}::uuid)
      on conflict(provider, external_store_id) where status not in ('disconnected','revoked')
      do update set status='connected',health_status='healthy',external_store_name=excluded.external_store_name,connected_at=now(),updated_at=now(),sync_cursor=excluded.sync_cursor
      returning *
    `.execute(this.db);
    const connectionId = String(inserted.rows[0]!.id);
    await this.storeCredentialReference(connectionId, "access_token", `salla:access_token:${connectionId}`);
    if (token.refreshToken) await this.storeCredentialReference(connectionId, "refresh_token", `salla:refresh_token:${connectionId}`);
    await this.storeCredentialReference(connectionId, "webhook_secret", "env:SALLA_WEBHOOK_SECRET");
    return { status: "connected", provider: "salla", connectionId, storeId, storeName: store.name || "Salla Store" };
  }

  public async startShopifyConnection(input: StartShopifyConnectionDto) {
    this.providers.get("shopify");
    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
    const redirectUri = process.env.SHOPIFY_REDIRECT_URI?.trim();
    if (!clientId || !redirectUri) throw new BadRequestException("shopify_oauth_not_configured");
    let shopDomain: string;
    try {
      shopDomain = normalizeShopifyShopDomain(input.shopDomain);
    } catch {
      throw new BadRequestException("shopify_shop_domain_invalid");
    }
    const actor = this.identity.current().identityId;
    const link = (await sql<Record<string, unknown>>`
      select trader_commerce_id from trader_commerce_company_links
      where company_id=${input.companyId}::uuid and trader_id=${input.traderId}::uuid and trader_commerce_id=${input.traderCommerceId}::uuid and status='active'
    `.execute(this.db)).rows[0];
    if (!link) throw new BadRequestException("trader_commerce_link_not_found");
    const state = randomBytes(32).toString("base64url");
    await sql`
      insert into commerce_integration_oauth_states(provider,state_hash,company_id,trader_id,trader_commerce_id,requested_by_account_id,redirect_after,expires_at)
      values('shopify',${hashSecret(state)},${input.companyId}::uuid,${input.traderId}::uuid,${input.traderCommerceId}::uuid,${actor}::uuid,${input.redirectAfter ?? null},now()+interval '10 minutes')
    `.execute(this.db);
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", shopifyScopes);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), expiresInSeconds: 600, provider: "shopify", shopDomain };
  }

  public async startTraderShopifyConnection(input: StartTraderShopifyConnectionDto) {
    const context = await this.currentTraderContext(input.traderCommerceId);
    return this.startShopifyConnection({
      companyId: context.companyId,
      traderId: context.traderId,
      traderCommerceId: context.traderCommerceId,
      shopDomain: input.shopDomain,
      redirectAfter: input.redirectAfter ?? "/integrations",
    });
  }

  public async completeShopifyCallback(query: Record<string, string | undefined>) {
    if (query.error) return { status: "cancelled", message: "Shopify connection was not completed." };
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    if (!clientSecret) throw new BadRequestException("shopify_oauth_not_configured");
    if (!query.code || !query.state || !query.shop || !query.hmac) throw new BadRequestException("shopify_oauth_callback_invalid");
    let shopDomain: string;
    try {
      shopDomain = normalizeShopifyShopDomain(query.shop);
    } catch {
      throw new BadRequestException("shopify_shop_domain_invalid");
    }
    if (!verifyShopifyCallbackHmac(query, clientSecret)) throw new BadRequestException("shopify_oauth_hmac_invalid");
    const stateHash = hashSecret(query.state);
    const state = (await sql<Record<string, unknown>>`
      update commerce_integration_oauth_states
      set status='consumed',consumed_at=now()
      where provider='shopify' and state_hash=${stateHash} and status='pending' and expires_at > now()
      returning *
    `.execute(this.db)).rows[0];
    if (!state) throw new BadRequestException("shopify_oauth_state_invalid");
    const token = await this.exchangeShopifyCode(shopDomain, query.code);
    const store = await this.fetchShopifyStoreIdentity(shopDomain, token.accessToken);
    const provider = this.providers.get("shopify");
    const reference = await ref(this.db, "commerce_integration_connection_reference_seq", "CIN");
    const storeId = store.id || shopDomain;
    const webhookRegistration = await this.registerShopifyWebhooks(shopDomain, token.accessToken, reference);
    const inserted = await sql<Record<string, unknown>>`
      insert into commerce_integration_connections(reference_number,company_id,trader_id,trader_commerce_id,provider,external_store_id,external_store_name,status,connection_mode,health_status,capabilities,sync_cursor,connected_at,created_by_account_id)
      values(${reference},${String(state.company_id)}::uuid,${String(state.trader_id)}::uuid,${String(state.trader_commerce_id)}::uuid,'shopify',${storeId},${store.name || shopDomain},'connected','bidirectional','healthy',${JSON.stringify(provider.capabilities())}::jsonb,${JSON.stringify({ shopifyShop: store.safeMetadata, oauthScope: token.scope, apiVersion: shopifyApiVersion(), webhookRegistration })}::jsonb,now(),${String(state.requested_by_account_id)}::uuid)
      on conflict(provider, external_store_id) where status not in ('disconnected','revoked')
      do update set status='connected',health_status='healthy',external_store_name=excluded.external_store_name,connected_at=now(),updated_at=now(),sync_cursor=excluded.sync_cursor
      returning *
    `.execute(this.db);
    const connectionId = String(inserted.rows[0]!.id);
    await this.storeCredentialReference(connectionId, "access_token", `shopify:access_token:${connectionId}`);
    await this.storeCredentialReference(connectionId, "webhook_secret", process.env.SHOPIFY_WEBHOOK_SECRET?.trim() ? "env:SHOPIFY_WEBHOOK_SECRET" : "env:SHOPIFY_CLIENT_SECRET");
    return { status: "connected", provider: "shopify", connectionId, storeId, storeName: store.name || shopDomain, shopDomain };
  }

  public async connections(query: Record<string, string | undefined> = {}) {
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 25) || 25, 1), 100);
    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const offset = (page - 1) * pageSize;
    const filters = [sql`true`];
    if (query.status && query.status !== "all") filters.push(sql`connection.status=${query.status}`);
    if (query.provider && query.provider !== "all") filters.push(sql`connection.provider=${query.provider}`);
    if (query.search?.trim()) {
      const search = `%${query.search.trim().toLowerCase()}%`;
      filters.push(sql`(lower(connection.reference_number) like ${search} or lower(connection.external_store_name) like ${search} or lower(trader.name_en) like ${search} or lower(company.name_en) like ${search})`);
    }
    const where = sql.join(filters, sql` and `);
    const rows = await sql<Record<string, unknown>>`
      select connection.*,company.name_en company_name,trader.name_en trader_name,
        coalesce(event_counts.total_events,0)::int total_events,
        coalesce(event_counts.failed_events,0)::int failed_events,
        coalesce(order_counts.imported_orders,0)::int imported_orders
      from commerce_integration_connections connection
      join companies company on company.id=connection.company_id
      join traders trader on trader.id=connection.trader_id and trader.company_id=connection.company_id
      left join lateral (select count(*) total_events,count(*) filter(where status in('failed','retrying','rejected')) failed_events from commerce_integration_events where connection_id=connection.id) event_counts on true
      left join lateral (select count(*) imported_orders from commerce_integration_order_links where connection_id=connection.id) order_counts on true
      where ${where}
      order by connection.updated_at desc
      limit ${pageSize} offset ${offset}
    `.execute(this.db);
    const total = await sql<{ count: string }>`select count(*)::text count from commerce_integration_connections connection join companies company on company.id=connection.company_id join traders trader on trader.id=connection.trader_id and trader.company_id=connection.company_id where ${where}`.execute(this.db);
    return { items: rows.rows.map(mapRow), page, pageSize, total: Number(total.rows[0]?.count ?? "0") };
  }

  public async traderConnections(query: Record<string, string | undefined> = {}) {
    const context = await this.currentTraderContext();
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 25) || 25, 1), 100);
    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const offset = (page - 1) * pageSize;
    const filters = [
      sql`connection.company_id=${context.companyId}::uuid`,
      sql`connection.trader_id=${context.traderId}::uuid`,
    ];
    if (query.status && query.status !== "all") filters.push(sql`connection.status=${query.status}`);
    if (query.provider && query.provider !== "all") filters.push(sql`connection.provider=${query.provider}`);
    if (query.search?.trim()) {
      const search = `%${query.search.trim().toLowerCase()}%`;
      filters.push(sql`(lower(connection.reference_number) like ${search} or lower(connection.external_store_name) like ${search})`);
    }
    const where = sql.join(filters, sql` and `);
    const rows = await sql<Record<string, unknown>>`
      select connection.*,
        coalesce(event_counts.total_events,0)::int total_events,
        coalesce(event_counts.failed_events,0)::int failed_events,
        coalesce(order_counts.imported_orders,0)::int imported_orders
      from commerce_integration_connections connection
      left join lateral (select count(*) total_events,count(*) filter(where status in('failed','retrying','rejected')) failed_events from commerce_integration_events where connection_id=connection.id) event_counts on true
      left join lateral (select count(*) imported_orders from commerce_integration_order_links where connection_id=connection.id) order_counts on true
      where ${where}
      order by connection.updated_at desc
      limit ${pageSize} offset ${offset}
    `.execute(this.db);
    const total = await sql<{ count: string }>`select count(*)::text count from commerce_integration_connections connection where ${where}`.execute(this.db);
    return { items: rows.rows.map(mapRow), page, pageSize, total: Number(total.rows[0]?.count ?? "0") };
  }

  public async connection(id: string) {
    const connection = (await sql<Record<string, unknown>>`
      select connection.*,company.name_en company_name,trader.name_en trader_name,exists(select 1 from commerce_integration_credentials credential where credential.connection_id=connection.id and credential.status='configured') credential_configured
      from commerce_integration_connections connection
      join companies company on company.id=connection.company_id
      join traders trader on trader.id=connection.trader_id and trader.company_id=connection.company_id
      where connection.id=${id}::uuid
    `.execute(this.db)).rows[0];
    if (!connection) throw new NotFoundException();
    const events = await this.events(id, { pageSize: "25" });
    const mappings = await sql<Record<string, unknown>>`
      select mapping.*,area.name_en area_name from commerce_integration_area_mappings mapping join areas area on area.id=mapping.area_id and area.company_id=mapping.company_id
      where mapping.connection_id=${id}::uuid order by mapping.created_at desc
    `.execute(this.db);
    return { ...mapRow(connection), credentialConfigured: Boolean(connection.credential_configured), events: events.items, mappings: mappings.rows.map(mapRow) };
  }

  public async traderConnection(id: string) {
    await this.traderConnectionById(id);
    return this.connection(id);
  }

  public async events(connectionId: string, query: Record<string, string | undefined> = {}) {
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 25) || 25, 1), 100);
    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const offset = (page - 1) * pageSize;
    const filters = [sql`event.connection_id=${connectionId}::uuid`];
    if (query.status && query.status !== "all") filters.push(sql`event.status=${query.status}`);
    if (query.eventType && query.eventType !== "all") filters.push(sql`event.event_type=${query.eventType}`);
    if (query.search?.trim()) {
      const search = `%${query.search.trim().toLowerCase()}%`;
      filters.push(sql`(lower(coalesce(event.external_reference,'')) like ${search} or lower(coalesce(event.external_order_id,'')) like ${search})`);
    }
    const where = sql.join(filters, sql` and `);
    const rows = await sql<Record<string, unknown>>`
      select event.*,orders.order_number tawseelhub_order_number
      from commerce_integration_events event
      left join orders on orders.id=event.tawseelhub_order_id and orders.company_id=event.company_id
      where ${where}
      order by event.received_at desc
      limit ${pageSize} offset ${offset}
    `.execute(this.db);
    const total = await sql<{ count: string }>`select count(*)::text count from commerce_integration_events event where ${where}`.execute(this.db);
    return { items: rows.rows.map(mapRow), page, pageSize, total: Number(total.rows[0]?.count ?? "0") };
  }

  public async traderEvents(connectionId: string, query: Record<string, string | undefined> = {}) {
    await this.traderConnectionById(connectionId);
    return this.events(connectionId, query);
  }

  public async traderAreaOptions(connectionId: string, query: Record<string, string | undefined> = {}) {
    await this.traderConnectionById(connectionId);
    return this.areaOptions(connectionId, query);
  }

  public async areaOptions(connectionId: string, query: Record<string, string | undefined> = {}) {
    const connection = await this.connectionById(connectionId);
    const search = `%${(query.search ?? "").trim().toLowerCase()}%`;
    const rows = await sql<Record<string, unknown>>`
      select id,name_en,code from areas
      where company_id=${String(connection.company_id)}::uuid
        and is_active
        and (${(query.search ?? "").trim() || null}::text is null or lower(name_en) like ${search} or lower(code) like ${search})
      order by name_en
      limit 100
    `.execute(this.db);
    return { items: rows.rows.map(mapRow) };
  }

  public async webhook(providerKey: string, connectionReference: string, body: unknown, rawBody?: Buffer, signature?: string, headers?: CommerceWebhookHeaders) {
    const provider = this.providers.get(providerKey);
    const connection = await this.connectionByReference(connectionReference);
    if (connection.provider !== provider.key) throw new BadRequestException("commerce_provider_connection_mismatch");
    if (!provider.verifyWebhook({ body, connectionReference, ...(rawBody ? { rawBody } : {}), ...(signature ? { signature } : {}), ...(headers ? { headers } : {}) })) {
      await this.recordRejected(connection, body, "signature_invalid", "Webhook signature was invalid.");
      throw new BadRequestException("signature_invalid");
    }
    await sql`update commerce_integration_connections set last_webhook_at=now(),updated_at=now() where id=${String(connection.id)}::uuid`.execute(this.db);
    return this.processEvent(connection, provider.parseWebhook({ body, ...(headers ? { headers } : {}) }), body);
  }

  public async simulate(connectionId: string, input: SimulateCommerceEventDto) {
    const connection = await this.connectionById(connectionId);
    if (connection.provider !== "mock_commerce") throw new BadRequestException("mock_provider_required");
    this.providers.get("mock_commerce");
    const body = {
      eventType: input.eventType,
      externalEventId: input.externalEventId ?? `mock-event-${Date.now()}`,
      order: input.order ?? {},
      providerState: input.providerState,
      simulateFailure: input.simulateFailure,
    };
    if (input.invalidSignature) {
      await this.recordRejected(connection, body, "signature_invalid", "Mock invalid signature was rejected.");
      return { status: "rejected", errorCode: "signature_invalid" };
    }
    const signature = signMockCommercePayload(String(connection.reference_number), body);
    return this.webhook("mock_commerce", String(connection.reference_number), body, undefined, signature);
  }

  public async traderSyncNow(connectionId: string) {
    const connection = await this.traderConnectionById(connectionId);
    const eventId = await this.insertEvent({
      connection,
      eventType: "sync.requested",
      externalEventId: `trader-sync-${Date.now()}`,
      payload: { requestedBy: "trader_portal" },
      status: "succeeded",
    });
    await sql`update commerce_integration_connections set last_success_at=now(),updated_at=now() where id=${connectionId}::uuid`.execute(this.db);
    return { eventId, status: "recorded", message: "Sync request recorded." };
  }

  public async retryEvent(eventId: string) {
    const event = (await sql<Record<string, unknown>>`select * from commerce_integration_events where id=${eventId}::uuid`.execute(this.db)).rows[0];
    if (!event) throw new NotFoundException();
    if (!["failed", "retrying"].includes(String(event.status))) throw new BadRequestException("event_not_retryable");
    const connection = await this.connectionById(String(event.connection_id));
    if (event.external_order_id) {
      const linked = await this.orderLink(connection, String(event.external_order_id));
      if (linked) {
        await sql`update commerce_integration_events set attempt_count=attempt_count+1,next_retry_at=null where id=${eventId}::uuid`.execute(this.db);
        await this.finalizeEvent(String(event.id), "duplicate", String(linked.order_id), `Existing Tawseelhub Order ${String(linked.order_number ?? linked.order_id)} already linked; retry did not create a duplicate.`);
        return { status: "duplicate", eventStatus: "duplicate", orderId: linked.order_id, orderReference: linked.order_number ?? null, externalReference: event.external_reference ?? event.external_order_id };
      }
    }
    const normalized = this.providers.get(String(connection.provider)).parseWebhook({ body: event.sanitized_payload });
    await sql`update commerce_integration_events set status='retrying',attempt_count=attempt_count+1,next_retry_at=null where id=${eventId}::uuid`.execute(this.db);
    const result = await this.applyEvent(connection, normalized, String(event.id), event.sanitized_payload);
    return { ...result, eventStatus: result.status };
  }

  public async testConnection(id: string, requestedState?: "healthy" | "degraded" | "unauthorized") {
    const connection = await this.connectionById(id);
    const health = this.providers.get(String(connection.provider)).healthCheck(requestedState ? { requestedState } : {});
    await sql`
      update commerce_integration_connections
      set health_status=${health.status},status=case when ${health.status}='healthy' then 'connected' when ${health.status}='degraded' then 'degraded' else 'error' end,last_health_check_at=now(),last_error_at=case when ${health.status}<>'healthy' then now() else last_error_at end,last_error_code=case when ${health.status}<>'healthy' then ${health.status} else null end,last_error_message_safe=case when ${health.status}<>'healthy' then ${health.message} else null end,updated_at=now()
      where id=${id}::uuid
    `.execute(this.db);
    return this.connection(id);
  }

  public async disconnect(id: string, input: DisconnectCommerceConnectionDto) {
    const actor = this.identity.current().identityId;
    await sql`update commerce_integration_connections set status='disconnected',disconnected_at=now(),disconnected_by_account_id=${actor}::uuid,disconnect_reason=${input.reason?.trim() ?? null},updated_at=now() where id=${id}::uuid`.execute(this.db);
    return this.connection(id);
  }

  public async traderDisconnect(id: string, input: DisconnectCommerceConnectionDto) {
    await this.traderConnectionById(id);
    return this.disconnect(id, input);
  }

  public async reconnect(id: string) {
    await sql`update commerce_integration_connections set status='connected',health_status='healthy',connected_at=coalesce(connected_at,now()),disconnected_at=null,disconnected_by_account_id=null,disconnect_reason=null,updated_at=now() where id=${id}::uuid`.execute(this.db);
    return this.connection(id);
  }

  public async traderReconnect(id: string) {
    await this.traderConnectionById(id);
    return this.reconnect(id);
  }

  public async saveAreaMapping(connectionId: string, input: CommerceAreaMappingDto) {
    const actor = this.identity.current().identityId;
    const connection = await this.connectionById(connectionId);
    await sql`
      insert into commerce_integration_area_mappings(connection_id,company_id,provider,external_value,normalized_external_value,area_id,created_by_account_id)
      values(${connectionId}::uuid,${String(connection.company_id)}::uuid,${String(connection.provider)},${input.externalValue.trim()},${normalizeIdentifier(input.externalValue)},${input.areaId}::uuid,${actor}::uuid)
      on conflict(connection_id,provider,normalized_external_value) do update set area_id=excluded.area_id,status='active',updated_at=now()
    `.execute(this.db);
    return this.connection(connectionId);
  }

  public async traderSaveAreaMapping(connectionId: string, input: CommerceAreaMappingDto) {
    await this.traderConnectionById(connectionId);
    return this.saveAreaMapping(connectionId, input);
  }

  public async outboundDelivered(orderId: string) {
    const link = (await sql<Record<string, unknown>>`
      select link.*,connection.reference_number,connection.provider,connection.status connection_status from commerce_integration_order_links link join commerce_integration_connections connection on connection.id=link.connection_id
      where link.order_id=${orderId}::uuid
    `.execute(this.db)).rows[0];
    if (!link) throw new NotFoundException();
    if (link.last_outbound_status === "delivered") return { status: "duplicate", result: "Delivered already synchronized" };
    const provider = this.providers.get(String(link.provider));
    const pushed = provider.pushOrderStatus({ externalOrderId: String(link.external_order_id), status: "delivered" });
    const eventId = await this.insertEvent({
      connection: { id: link.connection_id, company_id: link.company_id, trader_id: link.trader_id, provider: link.provider },
      externalEventId: `outbound-${orderId}-delivered`,
      eventType: "fulfillment.updated",
      externalOrderId: String(link.external_order_id),
      externalReference: String(link.external_order_number),
      payload: { orderId, status: "delivered" },
      status: "succeeded",
    });
    await sql`update commerce_integration_order_links set last_outbound_status='delivered',last_outbound_synced_at=now(),updated_at=now() where id=${String(link.id)}::uuid`.execute(this.db);
    return { eventId, status: "succeeded", result: pushed.providerMessage };
  }

  private async processEvent(connection: Record<string, unknown>, event: NormalizedCommerceEvent, payload: unknown) {
    if (connection.status !== "connected" && event.eventType !== "connection.revoked") {
      await this.recordRejected(connection, payload, "connection_not_connected", "Connection is not connected.");
      return { status: "rejected", errorCode: "connection_not_connected" };
    }
    const externalReference = event.externalReference ?? event.order?.externalOrderNumber;
    const inserted = await this.insertEvent({
      connection,
      eventType: event.eventType,
      externalEventId: event.externalEventId,
      payload,
      status: "processing",
      ...(event.order?.externalOrderId ? { externalOrderId: event.order.externalOrderId } : {}),
      ...(externalReference ? { externalReference } : {}),
    });
    if (inserted === "duplicate") return { status: "duplicate", result: "Duplicate ignored" };
    return this.applyEvent(connection, event, inserted, payload);
  }

  private async applyEvent(connection: Record<string, unknown>, event: NormalizedCommerceEvent, eventId: string, payload: unknown) {
    try {
      if (event.simulateFailure === "timeout") throw new Error("provider_unavailable");
      if (event.simulateFailure === "processing_failure") throw new Error("internal_error");
      if (event.eventType === "order.created") return await this.importOrder(connection, eventId, event.order);
      if (event.eventType === "order.updated") return await this.updateOrder(connection, eventId, event.order);
      if (event.eventType === "order.cancelled") return await this.cancelOrder(connection, eventId, event.order);
      if (event.eventType === "connection.revoked") {
        await sql`update commerce_integration_connections set status='revoked',last_error_at=now(),last_error_code='credential_revoked',updated_at=now() where id=${String(connection.id)}::uuid`.execute(this.db);
        await this.succeedEvent(eventId, null, "Connection revoked by provider.");
        return { status: "succeeded", result: "Connection revoked" };
      }
      await this.succeedEvent(eventId, null, "Event recorded.");
      return { status: "succeeded", result: "Event recorded" };
    } catch (error) {
      const databaseConstraint = typeof (error as { constraint?: unknown }).constraint === "string" ? String((error as { constraint: string }).constraint) : null;
      const databaseCode = typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : null;
      const code = databaseConstraint
        ? `db_${databaseConstraint}`.slice(0, 120)
        : databaseCode
          ? `db_${databaseCode}`
          : error instanceof Error && ["area_unresolved", "mapping_failed", "provider_unavailable", "internal_error", "order_conflict"].includes(error.message)
            ? error.message
            : "internal_error";
      await sql`
        update commerce_integration_events set status='failed',attempt_count=attempt_count+1,next_retry_at=now()+interval '15 minutes',error_code=${code},error_message_safe=${this.safeError(code)},processed_at=now(),sanitized_payload=${JSON.stringify(sanitizePayload(payload))}::jsonb where id=${eventId}::uuid
      `.execute(this.db);
      await sql`update commerce_integration_connections set status=case when ${code} in('provider_unavailable','internal_error') then 'degraded' else status end,last_error_at=now(),last_error_code=${code},last_error_message_safe=${this.safeError(code)},updated_at=now() where id=${String(connection.id)}::uuid`.execute(this.db);
      return { status: "failed", errorCode: code, message: this.safeError(code) };
    }
  }

  private async importOrder(connection: Record<string, unknown>, eventId: string, order: NormalizedCommerceOrder | undefined) {
    if (!order) throw new Error("payload_invalid");
    const existing = await sql<Record<string, unknown>>`select order_id from commerce_integration_order_links where connection_id=${String(connection.id)}::uuid and external_order_id=${order.externalOrderId}`.execute(this.db);
    if (existing.rows[0]) {
      await this.finalizeEvent(eventId, "duplicate", String(existing.rows[0].order_id), "Duplicate external Order ignored; existing Tawseelhub Order remains canonical.");
      return { status: "duplicate", orderId: existing.rows[0].order_id };
    }
    if (order.currency !== "AED") throw new Error("mapping_failed");
    const area = await this.resolveArea(connection, order.area);
    const orderNumber = await this.nextCompanyReference(String(connection.company_id), "order", "ORD");
    const serial = order.externalOrderNumber;
    const normalized = normalizeIdentifier(serial);
    const mobile = normalizeMobile(order.customerMobile);
    const cod = order.codRequired ? order.codAmount : 0;
    const packageCount = Math.max(1, Math.trunc(order.packageCount));
    const actor = await this.companyActor(String(connection.company_id), String(connection.trader_id));
    const inserted = await sql<{ id: string }>`
      insert into orders(company_id,order_number,serial_number,serial_number_normalized,reference_number,reference_number_normalized,financial_model_version,order_date,trader_id,area_id,created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,payment_condition,cod_amount,service_fee,service_fee_net_amount,service_fee_vat_amount,additional_fees,additional_fee_vat_amount,total_deductions,customer_amount_due,trader_gross_payable,trader_paid_service_fee,trader_deductions,trader_net_payable,driver_cost,vat_amount,vat_enabled_snapshot,vat_rate_snapshot,vat_price_mode_snapshot,company_revenue,order_profit,delivery_status,trader_settlement_status,pricing_provenance_status,configured_service_fee_snapshot,final_service_fee_snapshot,service_fee_override_reason,notes,order_type,customer_provenance_status)
      values(${String(connection.company_id)}::uuid,${orderNumber},${serial},${normalized},${order.externalOrderNumber},${normalizeIdentifier(order.externalOrderNumber)},'trader_deduction_v1',current_date,${String(connection.trader_id)}::uuid,${String(area.id)}::uuid,${actor}::uuid,${order.customerName},${mobile},${order.address},${packageCount},'customer_pays_cod_trader_pays_fee',${cod.toFixed(2)},0,0,0,0,0,0,${cod.toFixed(2)},${cod.toFixed(2)},0,0,${cod.toFixed(2)},0,0,false,0,null,0,0,'new',${cod > 0 ? "unsettled" : "not_eligible"},'manual',0,0,'Commerce integration import — service fee handled by Tawseelhub pricing review',${order.notes ?? "Imported from commerce integration"},'delivery','not_applicable')
      returning id
    `.execute(this.db);
    const orderId = inserted.rows[0]!.id;
    await sql`insert into order_status_history(company_id,order_id,status_dimension,to_status,changed_by_account_id) values(${String(connection.company_id)}::uuid,${orderId}::uuid,'delivery','new',${actor}::uuid)`.execute(this.db);
    await sql`insert into order_events(company_id,order_id,event_type,event_category,field_name,new_value,actor_account_id,actor_role,source,correlation_id) values(${String(connection.company_id)}::uuid,${orderId}::uuid,'order.created','system_action','delivery_status',to_jsonb('new'::text),${actor}::uuid,'System','import',${eventId})`.execute(this.db);
    await sql`
      insert into commerce_integration_order_links(connection_id,company_id,trader_id,order_id,provider,external_order_id,external_order_number,external_order_number_normalized,external_updated_at,last_inbound_event_id,product_snapshot,metadata)
      values(${String(connection.id)}::uuid,${String(connection.company_id)}::uuid,${String(connection.trader_id)}::uuid,${orderId}::uuid,${String(connection.provider)},${order.externalOrderId},${order.externalOrderNumber},${normalizeIdentifier(order.externalOrderNumber)},${order.updatedAt ?? null},${eventId}::uuid,${JSON.stringify(order.items)}::jsonb,${JSON.stringify({ customerEmail: order.customerEmail ?? null, countryCode: order.countryCode, emirate: order.emirate ?? null })}::jsonb)
    `.execute(this.db);
    await this.succeedEvent(eventId, orderId, `Imported as ${orderNumber}.`);
    return { status: "succeeded", orderId, orderNumber };
  }

  private async updateOrder(connection: Record<string, unknown>, eventId: string, order: NormalizedCommerceOrder | undefined) {
    if (!order) throw new Error("payload_invalid");
    const link = await this.orderLink(connection, order.externalOrderId);
    if (!link) return this.importOrder(connection, eventId, order);
    if (!["new", "in_branch", "assigned_to_driver", "hold"].includes(String(link.delivery_status))) throw new Error("order_conflict");
    const area = await this.resolveArea(connection, order.area);
    const cod = order.codRequired ? order.codAmount : 0;
    await sql`
      update orders set customer_name=${order.customerName},customer_mobile_number=${normalizeMobile(order.customerMobile)},customer_address=${order.address},area_id=${String(area.id)}::uuid,cod_amount=${cod.toFixed(2)},customer_amount_due=${cod.toFixed(2)},trader_gross_payable=${cod.toFixed(2)},trader_net_payable=${cod.toFixed(2)},package_count=${Math.max(1, Math.trunc(order.packageCount))},updated_at=now(),version=version+1
      where id=${String(link.order_id)}::uuid and company_id=${String(connection.company_id)}::uuid
    `.execute(this.db);
    await sql`update commerce_integration_order_links set external_updated_at=${order.updatedAt ?? null},last_inbound_event_id=${eventId}::uuid,product_snapshot=${JSON.stringify(order.items)}::jsonb,updated_at=now() where id=${String(link.id)}::uuid`.execute(this.db);
    await this.succeedEvent(eventId, String(link.order_id), "Order update applied.");
    return { status: "succeeded", orderId: link.order_id };
  }

  private async cancelOrder(connection: Record<string, unknown>, eventId: string, order: NormalizedCommerceOrder | undefined) {
    if (!order) throw new Error("payload_invalid");
    const link = await this.orderLink(connection, order.externalOrderId);
    if (!link) throw new Error("mapping_failed");
    if (["delivered", "closed"].includes(String(link.delivery_status))) throw new Error("order_conflict");
    await sql`update orders set delivery_status='cancelled',delivery_reason='Cancelled by commerce provider',trader_settlement_status='not_eligible',updated_at=now(),version=version+1 where id=${String(link.order_id)}::uuid and company_id=${String(connection.company_id)}::uuid`.execute(this.db);
    await sql`insert into order_status_history(company_id,order_id,status_dimension,from_status,to_status,reason) values(${String(connection.company_id)}::uuid,${String(link.order_id)}::uuid,'delivery',${String(link.delivery_status)},'cancelled','Cancelled by commerce provider')`.execute(this.db);
    await this.succeedEvent(eventId, String(link.order_id), "Order cancelled.");
    return { status: "succeeded", orderId: link.order_id };
  }

  private async resolveArea(connection: Record<string, unknown>, externalArea: string) {
    const normalized = normalizeIdentifier(externalArea);
    const mapped = (await sql<Record<string, unknown>>`
      select area.id,area.name_en from commerce_integration_area_mappings mapping join areas area on area.id=mapping.area_id and area.company_id=mapping.company_id
      where mapping.company_id=${String(connection.company_id)}::uuid and mapping.provider=${String(connection.provider)} and mapping.normalized_external_value=${normalized} and mapping.status='active'
        and (mapping.connection_id is null or mapping.connection_id=${String(connection.id)}::uuid)
      order by mapping.connection_id nulls last limit 1
    `.execute(this.db)).rows[0];
    if (mapped) return mapped;
    const area = (await sql<Record<string, unknown>>`
      select id,name_en from areas where company_id=${String(connection.company_id)}::uuid and is_active and (lower(name_en)=${normalized} or lower(code)=${normalized}) limit 1
    `.execute(this.db)).rows[0];
    if (!area) throw new Error("area_unresolved");
    return area;
  }

  private async orderLink(connection: Record<string, unknown>, externalOrderId: string) {
    return (await sql<Record<string, unknown>>`
      select link.*,orders.delivery_status,orders.order_number from commerce_integration_order_links link join orders on orders.id=link.order_id and orders.company_id=link.company_id
      where link.connection_id=${String(connection.id)}::uuid and link.external_order_id=${externalOrderId}
    `.execute(this.db)).rows[0];
  }

  private async insertEvent(input: { connection: Record<string, unknown>; eventType: string; externalEventId: string; externalReference?: string; externalOrderId?: string; payload: unknown; status: string }) {
    const inserted = await sql<{ id: string }>`
      insert into commerce_integration_events(connection_id,company_id,trader_id,provider,external_event_id,event_type,status,attempt_count,external_reference,external_order_id,sanitized_payload)
      values(${String(input.connection.id)}::uuid,${String(input.connection.company_id)}::uuid,${String(input.connection.trader_id)}::uuid,${String(input.connection.provider)},${input.externalEventId},${input.eventType},${input.status},case when ${input.status}='processing' then 1 else 0 end,${input.externalReference ?? null},${input.externalOrderId ?? null},${JSON.stringify(sanitizePayload(input.payload))}::jsonb)
      on conflict(connection_id,external_event_id) do nothing
      returning id
    `.execute(this.db);
    return inserted.rows[0]?.id ?? "duplicate";
  }

  private async succeedEvent(eventId: string, orderId: string | null, summary: string) {
    await this.finalizeEvent(eventId, "succeeded", orderId, summary);
  }

  private async finalizeEvent(eventId: string, status: CommerceEventTerminalStatus, orderId: string | null, summary: string) {
    if (orderId) {
      await sql`
        update commerce_integration_events
        set status=${status},tawseelhub_order_id=${orderId}::uuid,processed_at=now(),next_retry_at=null,result_summary=${summary},error_code=null,error_message_safe=null
        where id=${eventId}::uuid
      `.execute(this.db);
    } else {
      await sql`
        update commerce_integration_events
        set status=${status},tawseelhub_order_id=null,processed_at=now(),next_retry_at=null,result_summary=${summary},error_code=null,error_message_safe=null
        where id=${eventId}::uuid
      `.execute(this.db);
    }
    await sql`
      update commerce_integration_connections set status=case when status='degraded' then 'connected' else status end,last_success_at=now(),last_error_code=null,last_error_message_safe=null,updated_at=now() where id=(select connection_id from commerce_integration_events where id=${eventId}::uuid)
    `.execute(this.db);
  }

  private async recordRejected(connection: Record<string, unknown>, payload: unknown, code: string, message: string) {
    await this.insertEvent({ connection, eventType: "sync.requested", externalEventId: `rejected-${Date.now()}-${Math.random().toString(36).slice(2)}`, payload, status: "rejected" });
    await sql`update commerce_integration_connections set last_error_at=now(),last_error_code=${code},last_error_message_safe=${message},updated_at=now() where id=${String(connection.id)}::uuid`.execute(this.db);
  }

  private async connectionByReference(referenceNumber: string) {
    const row = (await sql<Record<string, unknown>>`select * from commerce_integration_connections where reference_number=${referenceNumber}`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private async connectionById(id: string) {
    const row = (await sql<Record<string, unknown>>`select * from commerce_integration_connections where id=${id}::uuid`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private async currentTraderContext(preferredTraderCommerceId?: string): Promise<TraderCommerceContext> {
    const identity = this.identity.current();
    if (identity.kind !== "trader" || identity.profileType !== "trader" || !identity.companyId || !identity.profileId) {
      throw new ForbiddenException("trader_identity_required");
    }
    const link = (await sql<Record<string, unknown>>`
      select trader_commerce_id
      from trader_commerce_company_links
      where company_id=${identity.companyId}::uuid
        and trader_id=${identity.profileId}::uuid
        and status='active'
        and (${preferredTraderCommerceId ?? null}::uuid is null or trader_commerce_id=${preferredTraderCommerceId ?? null}::uuid)
      order by created_at desc
      limit 1
    `.execute(this.db)).rows[0];
    if (!link) throw new BadRequestException("trader_commerce_link_not_found");
    return {
      companyId: identity.companyId,
      traderId: identity.profileId,
      traderCommerceId: String(link.trader_commerce_id),
    };
  }

  private async traderConnectionById(id: string) {
    const context = await this.currentTraderContext();
    const row = (await sql<Record<string, unknown>>`
      select * from commerce_integration_connections
      where id=${id}::uuid and company_id=${context.companyId}::uuid and trader_id=${context.traderId}::uuid
    `.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private async storeCredentialReference(connectionId: string, kind: "access_token" | "refresh_token" | "webhook_secret", reference: string) {
    await sql`
      insert into commerce_integration_credentials(connection_id,credential_kind,secret_reference,status)
      values(${connectionId}::uuid,${kind},${reference},'configured')
      on conflict(connection_id,credential_kind) do update set secret_reference=excluded.secret_reference,status='configured',updated_at=now()
    `.execute(this.db);
  }

  private async exchangeSallaCode(code: string) {
    const clientId = process.env.SALLA_CLIENT_ID?.trim();
    const clientSecret = process.env.SALLA_CLIENT_SECRET?.trim();
    const redirectUri = process.env.SALLA_REDIRECT_URI?.trim();
    if (!clientId || !clientSecret || !redirectUri) throw new BadRequestException("salla_oauth_not_configured");
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri });
    const response = await fetch("https://accounts.salla.sa/oauth2/token", { body, method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" } });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new BadRequestException("salla_token_exchange_failed");
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!accessToken) throw new BadRequestException("salla_token_exchange_failed");
    const expires = Number(payload.expires_in ?? payload.expires);
    return {
      accessToken,
      expiresAt: Number.isFinite(expires) ? new Date(Date.now() + expires * 1000).toISOString() : undefined,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
      scope: typeof payload.scope === "string" ? payload.scope : sallaScopes,
    };
  }

  private async fetchSallaStoreIdentity(accessToken: string) {
    const response = await fetch("https://accounts.salla.sa/oauth2/user/info", { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new BadRequestException("salla_store_identity_failed");
    const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
    const merchant = (data.merchant && typeof data.merchant === "object" ? data.merchant : data.store && typeof data.store === "object" ? data.store : data) as Record<string, unknown>;
    const id = String(merchant.id ?? merchant.store_id ?? data.id ?? "").trim();
    const name = String(merchant.name ?? merchant.store_name ?? data.name ?? "Salla Store").trim();
    return { id, name, safeMetadata: { id, name, emailConfigured: Boolean(merchant.email), domainConfigured: Boolean(merchant.domain) } };
  }

  private async exchangeShopifyCode(shopDomain: string, code: string) {
    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new BadRequestException("shopify_oauth_not_configured");
    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new BadRequestException("shopify_token_exchange_failed");
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!accessToken) throw new BadRequestException("shopify_token_exchange_failed");
    return { accessToken, scope: typeof payload.scope === "string" ? payload.scope : shopifyScopes };
  }

  private async shopifyGraphql(shopDomain: string, accessToken: string, query: string, variables?: Record<string, unknown>) {
    const response = await fetch(`https://${shopDomain}/admin/api/${shopifyApiVersion()}/graphql.json`, {
      body: JSON.stringify({ query, variables: variables ?? {} }),
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.errors) throw new BadRequestException("shopify_admin_api_failed");
    return payload;
  }

  private async fetchShopifyStoreIdentity(shopDomain: string, accessToken: string) {
    const payload = await this.shopifyGraphql(shopDomain, accessToken, `query TawseelhubShopIdentity { shop { id name myshopifyDomain primaryDomain { host url } } }`);
    const data = (payload.data && typeof payload.data === "object" ? payload.data : {}) as Record<string, unknown>;
    const shop = (data.shop && typeof data.shop === "object" ? data.shop : {}) as Record<string, unknown>;
    const primaryDomain = asRecord(shop.primaryDomain);
    const id = String(shop.id ?? shopDomain).trim();
    const name = String(shop.name ?? shopDomain).trim();
    const myshopifyDomain = String(shop.myshopifyDomain ?? shopDomain).trim();
    if (normalizeShopifyShopDomain(myshopifyDomain) !== shopDomain) throw new BadRequestException("shopify_shop_identity_mismatch");
    return { id, name, safeMetadata: { id, name, myshopifyDomain, primaryDomainHost: primaryDomain.host ?? null, primaryDomainConfigured: Boolean(primaryDomain.url) } };
  }

  private async registerShopifyWebhooks(shopDomain: string, accessToken: string, connectionReference: string) {
    const baseUrl = process.env.SHOPIFY_WEBHOOK_CALLBACK_BASE_URL?.trim();
    if (!baseUrl) throw new BadRequestException("shopify_webhook_base_url_not_configured");
    const callbackUrl = `${baseUrl.replace(/\/$/u, "")}/api/v1/integrations/commerce/shopify/webhook/${connectionReference}`;
    const mutation = `mutation TawseelhubWebhookCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }) {
        webhookSubscription { id topic endpoint { __typename } }
        userErrors { field message }
      }
    }`;
    const topics = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"];
    const registered: { topic: string; id: string }[] = [];
    for (const topic of topics) {
      const payload = await this.shopifyGraphql(shopDomain, accessToken, mutation, { topic, callbackUrl });
      const result = asRecord(asRecord(payload.data).webhookSubscriptionCreate);
      const errors = Array.isArray(result.userErrors) ? result.userErrors : [];
      if (errors.length) throw new BadRequestException("shopify_webhook_registration_failed");
      const subscription = asRecord(result.webhookSubscription);
      registered.push({ topic, id: String(subscription.id ?? "") });
    }
    return { callbackUrlConfigured: true, topics: registered, apiVersion: shopifyApiVersion() };
  }

  private async nextCompanyReference(companyId: string, referenceType: string, prefix: string) {
    const result = await sql<{ nextValue: string; prefix: string }>`insert into company_reference_counters(company_id,reference_type,next_value,prefix) values(${companyId}::uuid,${referenceType},2,${prefix}) on conflict(company_id,reference_type) do update set next_value=company_reference_counters.next_value+1,updated_at=now() returning prefix,(next_value-1)::text "nextValue"`.execute(this.db);
    return `${result.rows[0]!.prefix}-${result.rows[0]!.nextValue.padStart(6, "0")}`;
  }

  private async companyActor(companyId: string, traderId: string) {
    const row = (await sql<{ accountId: string }>`select account_id "accountId" from traders where company_id=${companyId}::uuid and id=${traderId}::uuid and account_id is not null`.execute(this.db)).rows[0];
    if (row) return row.accountId;
    const existing = (await sql<{ accountId: string }>`
      select id "accountId" from accounts
      where company_id=${companyId}::uuid and normalized_username='commerce.integration'
      limit 1
    `.execute(this.db)).rows[0];
    if (existing) return existing.accountId;
    const inserted = await sql<{ accountId: string }>`
      insert into accounts(company_id,account_kind,username,normalized_username,password_hash,status,preferred_language)
      values(${companyId}::uuid,'company_user','commerce.integration','commerce.integration','disabled-commerce-integration-system-actor','disabled','en')
      on conflict(company_id,normalized_username) where company_id is not null do update set updated_at=accounts.updated_at
      returning id "accountId"
    `.execute(this.db);
    return inserted.rows[0]!.accountId;
  }

  private safeError(code: string) {
    return ({
      area_unresolved: "The external area could not be mapped to a Tawseelhub Area.",
      internal_error: "The integration event could not be processed safely.",
      mapping_failed: "The commerce payload needs manual mapping or uses unsupported values.",
      order_conflict: "The Tawseelhub Order has progressed too far for this provider change.",
      provider_unavailable: "The provider did not respond in time.",
    } as Record<string, string>)[code] ?? "The integration event could not be processed.";
  }
}
