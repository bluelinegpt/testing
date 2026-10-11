import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import dotenv from "dotenv";
import OpenAI from "openai";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { companyOrdersAiEnabled } from "../company-configuration/orders-ai-settings.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { isOrderQuestionKey, type OrderQuestionKey } from "./order-questions.js";

/**
 * Orders question box (Aiman, 11 Oct 2026): the user types any question about
 * Orders, in Arabic or English, and gets the Orders list filtered to answer it.
 *
 * The AI NEVER sees or touches data and never writes SQL. It only turns the
 * question text into an allow-listed set of Orders filters (`Interpretation`).
 * Names it mentions (Driver, Trader, Area, Emirate) are resolved HERE, against
 * the current Company only; the answer is then the normal Company-scoped Orders
 * list, with the same permissions as always. A ready question is matched
 * first, without the AI. Every question is written to the audit log.
 */

export const DELIVERY_STATUSES = [
  "new",
  "assigned_to_driver",
  "in_branch",
  "out_for_delivery",
  "hold",
  "delivered",
  "returned_to_branch",
  "returned_to_trader",
  "cancelled",
  "closed",
] as const;
const CASH_STATUSES = ["pending", "reconciled", "not_applicable"] as const;
const SETTLEMENT_STATUSES = [
  "unsettled",
  "partially_settled",
  "money_sent_to_trader",
  "money_received_by_trader",
  "not_eligible",
] as const;
const ORDER_TYPES = ["delivery", "collect_order", "gcc_international"] as const;

/** What the AI may answer with -- nothing else is ever applied. */
export interface Interpretation {
  readonly aboutOrders: boolean;
  readonly cashStatus: (typeof CASH_STATUSES)[number] | null;
  readonly deliveredFrom: string | null;
  readonly deliveredTo: string | null;
  readonly deliveryStatuses: readonly (typeof DELIVERY_STATUSES)[number][];
  readonly driverName: string | null;
  readonly emirateName: string | null;
  readonly areaName: string | null;
  readonly orderDateFrom: string | null;
  readonly orderDateTo: string | null;
  readonly orderType: (typeof ORDER_TYPES)[number] | null;
  readonly question: OrderQuestionKey | null;
  readonly search: string | null;
  readonly settlementStatus: (typeof SETTLEMENT_STATUSES)[number] | null;
  readonly traderName: string | null;
}

export interface AskChip {
  /** Web filter keys this chip set -- removing the chip clears exactly these. */
  readonly filterKeys: readonly string[];
  readonly field: string;
  readonly value: string;
}

export interface AskResult {
  readonly chips: readonly AskChip[];
  /** Web Orders filters to apply (every other filter is cleared). */
  readonly filters: Readonly<Record<string, string>>;
  /** Names that matched nothing or more than one record; never guessed. */
  readonly notes: readonly { readonly field: string; readonly value: string; readonly candidates: readonly string[] }[];
  readonly source: "library" | "ai";
  readonly unsupported: boolean;
}

/** The AI behind the box. A class token so tests can swap in a fake. */
export abstract class OrderQuestionModel {
  public abstract configured(): boolean;
  public abstract interpret(input: {
    readonly language: "ar" | "en";
    readonly question: string;
    readonly today: string;
  }): Promise<unknown>;
}

const ready: readonly { readonly key: OrderQuestionKey; readonly patterns: readonly RegExp[] }[] = [
  { key: "ready_to_close", patterns: [/ready\s+to\s+close/i, /جاهز[ةه]?\s*(لل)?[إا]غلاق/u] },
  {
    key: "collect_from_driver",
    patterns: [
      /ready\s+to\s+(be\s+)?collect(ed)?(\s+from\s+(the\s+)?driver)?/i,
      /collect\s+from\s+(the\s+)?driver/i,
      /جاهز[ةه]?\s*للتحصيل(\s*من\s*المندوب)?/u,
      /تحصيل\s*من\s*المندوب/u,
    ],
  },
  {
    key: "pay_trader",
    patterns: [
      /waiting\s+(for\s+)?payment\s+to\s+(the\s+)?trader/i,
      /pay\s+(the\s+)?trader/i,
      /ready\s+(for|to)\s+pay(ment)?/i,
      /بانتظار\s*الدفع\s*للتاجر/u,
      /(ال)?جاهز[ةه]?\s*للدفع/u,
    ],
  },
  { key: "confirm_trader_receipt", patterns: [/(trader\s+)?not\s+confirmed/i, /لم\s*يؤكد\s*التاجر/u] },
  { key: "trader_owes_fees", patterns: [/traders?\s+owe/i, /عليهم\s*رسوم/u, /رسوم\s*مستحقة\s*على\s*التاجر/u] },
  {
    key: "no_driver",
    patterns: [/(with\s+)?no\s+driver(\s+assigned)?/i, /without\s+(a\s+)?driver/i, /(have|has)\s+no\s+driver(\s+assigned)?/i, /بدون\s*مندوب/u],
  },
  { key: "out_not_delivered", patterns: [/out\s+for\s+delivery.*not\s+delivered/i, /خارج\s*للتوصيل.*(لم|ما)/u] },
  { key: "on_hold", patterns: [/^\s*(which\s+orders\s+are\s+)?on\s+hold\??\s*$/i, /^\s*(أي\s*الطلبات\s*)?معلق[ةه]?؟?\s*$/u] },
];

const filler =
  /\b(which|what|show|me|all|the|orders?|are|is|list|please|today)\b|أي|ما\s*هي|اعرض|عرض|جميع|كافة|كل|الطلبات|طلبات|هي|من\s*فضلك|[?؟.!,،\s]/giu;

/**
 * A ready question asked in words: answered without the AI. Only when the
 * question says nothing more -- "ready to collect from Ali" carries a Driver,
 * so it goes to the AI, which can combine the question with that name.
 */
export function matchReadyQuestion(text: string): OrderQuestionKey | null {
  for (const candidate of ready) {
    for (const pattern of candidate.patterns) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(filler, "");
      if (rest.length <= 2) return candidate.key;
    }
  }
  return null;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 80): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
const date = (value: unknown): string | null =>
  typeof value === "string" && datePattern.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Whatever the AI returned, keep only allow-listed values. Anything unknown
 * is dropped, never passed on: the AI cannot widen what the list may filter.
 */
export function sanitizeInterpretation(raw: unknown): Interpretation {
  const input = record(raw);
  const statuses = Array.isArray(input.deliveryStatuses) ? input.deliveryStatuses : [];
  return {
    aboutOrders: input.aboutOrders !== false,
    areaName: text(input.areaName),
    cashStatus: oneOf(CASH_STATUSES, input.cashStatus),
    deliveredFrom: date(input.deliveredFrom),
    deliveredTo: date(input.deliveredTo),
    deliveryStatuses: [
      ...new Set(
        statuses
          .map((status) => oneOf(DELIVERY_STATUSES, status))
          .filter((status): status is (typeof DELIVERY_STATUSES)[number] => status !== null),
      ),
    ],
    driverName: text(input.driverName),
    emirateName: text(input.emirateName),
    orderDateFrom: date(input.orderDateFrom),
    orderDateTo: date(input.orderDateTo),
    orderType: oneOf(ORDER_TYPES, input.orderType),
    question: isOrderQuestionKey(input.question) ? input.question : null,
    search: text(input.search, 60),
    settlementStatus: oneOf(SETTLEMENT_STATUSES, input.settlementStatus),
    traderName: text(input.traderName),
  };
}

export const ORDER_QUESTION_SYSTEM_PROMPT = `You turn a question about delivery ORDERS into list filters for a UAE delivery company's back office.
The question may be Arabic or English. Reply with ONE JSON object only, no prose, with exactly these keys:
{
 "aboutOrders": boolean (false if the question is not about finding orders),
 "question": one of ["ready_to_close","collect_from_driver","pay_trader","confirm_trader_receipt","trader_owes_fees","no_driver","out_not_delivered","on_hold"] or null,
 "deliveryStatuses": array of ["new","assigned_to_driver","in_branch","out_for_delivery","hold","delivered","returned_to_branch","returned_to_trader","cancelled","closed"],
 "cashStatus": "pending" (cash still with the driver / not collected) | "reconciled" (collected from the driver) | "not_applicable" | null,
 "settlementStatus": "unsettled" (trader not paid) | "partially_settled" | "money_sent_to_trader" | "money_received_by_trader" | "not_eligible" | null,
 "driverName": string or null, "traderName": string or null, "areaName": string or null, "emirateName": string or null,
 "orderDateFrom": "YYYY-MM-DD" or null, "orderDateTo": "YYYY-MM-DD" or null (when the order was created),
 "deliveredFrom": "YYYY-MM-DD" or null, "deliveredTo": "YYYY-MM-DD" or null (when the order was delivered),
 "search": order number, reference number, customer name or mobile, or null,
 "orderType": "delivery" | "collect_order" | "gcc_international" | null
}
Rules:
- Use ONLY what the question asks. Leave everything else null or [].
- Names: copy the name exactly as written (Arabic or English); never translate or invent one.
- Dates are relative to "today" given in the input (Asia/Dubai). "yesterday" = today-1 for both From and To. "this week" = from the most recent Monday to today. "this month" = from the 1st to today. "last N days" = today-(N-1) to today.
- "delivered yesterday" uses deliveredFrom/deliveredTo, not deliveryStatuses.
- If the question is exactly one of the fixed questions (ready to close, ready to collect from the driver, waiting payment to the trader, paid but the trader has not confirmed, traders who owe fees, no driver, out for delivery and not delivered, on hold), set "question" and nothing else.
- Never answer the question itself, never add keys, never output anything except the JSON object.`;

/**
 * The AI behind the box, OpenAI-compatible. The first provider with a key in
 * the environment is used, read when a question is asked (not at start-up):
 *   1. OpenRouter -- OPENROUTER_API_KEY (model ORDERS_QUESTION_MODEL, default openai/gpt-4o-mini)
 *   2. Anthropic (Claude) -- ANTHROPIC_API_KEY, ANTHROPIC_MODEL (Messages API, no extra package)
 *   3. Moonshot (Kimi) -- MOONSHOT_API_KEY, MOONSHOT_BASE_URL, MOONSHOT_MODEL
 *   4. OpenAI -- OPENAI_API_KEY
 * Keys are never logged or returned.
 */
interface QuestionProvider {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly name: "anthropic" | "moonshot" | "openai" | "openrouter";
}

export function resolveOrderQuestionProvider(environment: NodeJS.ProcessEnv): QuestionProvider | null {
  const value = (name: string) => environment[name]?.trim() ?? "";
  const override = value("ORDERS_QUESTION_MODEL");
  if (value("OPENROUTER_API_KEY") !== "") {
    return {
      apiKey: value("OPENROUTER_API_KEY"),
      baseURL: "https://openrouter.ai/api/v1",
      model: override || "openai/gpt-4o-mini",
      name: "openrouter",
    };
  }
  if (value("ANTHROPIC_API_KEY") !== "") {
    return {
      apiKey: value("ANTHROPIC_API_KEY"),
      baseURL: "https://api.anthropic.com/v1",
      model: override || value("ANTHROPIC_MODEL") || "claude-haiku-4-5",
      name: "anthropic",
    };
  }
  if (value("MOONSHOT_API_KEY") !== "") {
    return {
      apiKey: value("MOONSHOT_API_KEY"),
      baseURL: value("MOONSHOT_BASE_URL") || "https://api.moonshot.ai/v1",
      model: override || value("MOONSHOT_MODEL") || "moonshot-v1-8k",
      name: "moonshot",
    };
  }
  if (value("OPENAI_API_KEY") !== "") {
    return {
      apiKey: value("OPENAI_API_KEY"),
      baseURL: "https://api.openai.com/v1",
      model: override || "gpt-4o-mini",
      name: "openai",
    };
  }
  return null;
}

const providerKeyNames = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "MOONSHOT_API_KEY", "OPENAI_API_KEY"];
/** The same files the API configuration reads (`app.module.ts`), first one wins. */
const environmentFiles = [".env", "../../.env"];

/**
 * The process environment, with any EMPTY or missing value filled from the
 * .env file. A variable that already exists in Windows (even empty) is never
 * overwritten by the .env file at start-up, so the key would silently be
 * missing; reading the file here closes that gap. No-op where there is no
 * .env file (Render).
 */
function questionEnvironment(): { readonly environment: NodeJS.ProcessEnv; readonly files: readonly string[] } {
  const merged: Record<string, string> = {};
  const files: string[] = [];
  for (const file of environmentFiles) {
    const path = resolvePath(process.cwd(), file);
    if (!existsSync(path)) continue;
    files.push(path);
    try {
      const parsed = dotenv.parse(readFileSync(path));
      for (const [name, value] of Object.entries(parsed)) {
        if (!(name in merged)) merged[name] = value;
      }
    } catch {
      // An unreadable file simply adds nothing.
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.trim() !== "") merged[name] = value;
  }
  return { environment: merged, files };
}

@Injectable()
export class OpenRouterOrderQuestionModel extends OrderQuestionModel {
  private readonly logger = new Logger("OrderQuestionModel");
  private cached: { readonly key: string; readonly client: OpenAI } | null = null;

  private reportedMissing = false;

  private provider(): QuestionProvider | null {
    const { environment, files } = questionEnvironment();
    const provider = resolveOrderQuestionProvider(environment);
    if (provider === null && !this.reportedMissing) {
      // Names only -- never a value.
      this.reportedMissing = true;
      const inProcess = providerKeyNames.filter((name) => name in process.env);
      this.logger.warn(
        `Orders question AI: no key found. Looked for ${providerKeyNames.join(", ")}. ` +
          `Working folder: ${process.cwd()}. .env files read: ${files.length === 0 ? "none" : files.join(", ")}. ` +
          `Present but empty in the process: ${inProcess.length === 0 ? "none" : inProcess.join(", ")}.`,
      );
    }
    if (provider !== null) this.reportedMissing = false;
    return provider;
  }

  private clientFor(provider: QuestionProvider): OpenAI {
    const key = `${provider.baseURL}|${provider.apiKey}`;
    if (this.cached?.key !== key) {
      this.cached = { client: new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL }), key };
    }
    return this.cached.client;
  }

  public configured(): boolean {
    return this.provider() !== null;
  }

  public async interpret(input: {
    readonly language: "ar" | "en";
    readonly question: string;
    readonly today: string;
  }): Promise<unknown> {
    const provider = this.provider();
    if (provider === null) throw new Error("order_question_ai_not_configured");
    const content =
      provider.name === "anthropic"
        ? await this.askAnthropic(provider, input)
        : await this.askOpenAiCompatible(provider, input);
    const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    try {
      return JSON.parse(json === "" ? "{}" : json) as unknown;
    } catch (error) {
      this.failed(provider, "reply_not_json");
      throw error;
    }
  }

  private failed(provider: QuestionProvider, status: unknown): void {
    // Provider, model and HTTP status only -- never the key or the question.
    this.logger.warn(
      `Orders question AI call failed (provider=${provider.name}, model=${provider.model}, status=${String(status ?? "none")})`,
    );
  }

  /** Anthropic Messages API over plain fetch (no extra package). */
  private async askAnthropic(provider: QuestionProvider, input: unknown): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${provider.baseURL}/messages`, {
        body: JSON.stringify({
          max_tokens: 400,
          messages: [{ content: JSON.stringify(input), role: "user" }],
          model: provider.model,
          system: ORDER_QUESTION_SYSTEM_PROMPT,
          // No `temperature`: newer Claude models reject it (HTTP 400).
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": provider.apiKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      this.failed(provider, "network");
      throw error;
    }
    if (!response.ok) {
      this.failed(provider, response.status);
      throw new Error(`anthropic_status_${response.status}`);
    }
    const body = (await response.json()) as { content?: readonly { text?: unknown; type?: unknown }[] };
    return (body.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }

  private async askOpenAiCompatible(provider: QuestionProvider, input: unknown): Promise<string> {
    const client = this.clientFor(provider);
    const completion = await client.chat.completions
      .create(
        {
          max_tokens: 400,
          messages: [
            { content: ORDER_QUESTION_SYSTEM_PROMPT, role: "system" },
            { content: JSON.stringify(input), role: "user" },
          ],
          model: provider.model,
          response_format: { type: "json_object" },
          temperature: 0,
        },
        { timeout: 20_000 },
      )
      .catch((error: unknown) => {
        this.failed(provider, (error as { status?: unknown } | null)?.status);
        throw error;
      });
    return completion.choices[0]?.message?.content ?? "";
  }
}

type NameTable = "areas" | "drivers" | "emirates" | "traders";

@Injectable()
export class OrderQuestionAskService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(OrderQuestionModel) private readonly model: OrderQuestionModel,
  ) {}

  public async ask(question: string, language: "ar" | "en"): Promise<AskResult> {
    const { companyId } = this.tenants.current();
    if (!(await companyOrdersAiEnabled(this.database, companyId))) {
      throw new ApplicationException(
        "order_question_ai_disabled",
        "Orders AI is not switched on for this Company.",
        HttpStatus.FORBIDDEN,
      );
    }
    const trimmed = question.trim();
    const libraryKey = matchReadyQuestion(trimmed);
    let result: AskResult;
    if (libraryKey !== null) {
      result = {
        chips: [{ field: "question", filterKeys: ["question"], value: libraryKey }],
        filters: { question: libraryKey, quickView: "all" },
        notes: [],
        source: "library",
        unsupported: false,
      };
    } else {
      if (!this.model.configured()) {
        throw new ApplicationException(
          "order_question_ai_unavailable",
          "The question box is not available right now. Use the quick questions.",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      let raw: unknown;
      try {
        raw = await this.model.interpret({ language, question: trimmed, today: await this.today(companyId) });
      } catch {
        throw new ApplicationException(
          "order_question_ai_unavailable",
          "The question could not be understood right now. Try again or use the quick questions.",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      result = await this.resolve(companyId, sanitizeInterpretation(raw));
    }
    const identity = this.identities.current();
    await this.history.audit(this.database, {
      action: "orders.question_asked",
      actorId: identity.identityId,
      after: { filters: result.filters, notes: result.notes, question: trimmed, source: result.source, unsupported: result.unsupported },
      companyId,
      correlationId: randomUUID(),
      subjectId: randomUUID(),
      subjectType: "orders_question",
    });
    return result;
  }

  /** Turns an allow-listed interpretation into web filters, resolving names in this Company only. */
  public async resolve(companyId: string, interpretation: Interpretation): Promise<AskResult> {
    if (!interpretation.aboutOrders) {
      return { chips: [], filters: {}, notes: [], source: "ai", unsupported: true };
    }
    const filters: Record<string, string> = { quickView: "all" };
    const chips: AskChip[] = [];
    const notes: { field: string; value: string; candidates: string[] }[] = [];
    if (interpretation.question !== null) {
      filters.question = interpretation.question;
      chips.push({ field: "question", filterKeys: ["question"], value: interpretation.question });
    }
    const names: readonly [keyof Interpretation & string, NameTable, string][] = [
      ["driverName", "drivers", "driverId"],
      ["traderName", "traders", "traderId"],
      ["areaName", "areas", "areaId"],
      ["emirateName", "emirates", "emirateId"],
    ];
    for (const [field, table, filterKey] of names) {
      const value = interpretation[field];
      if (typeof value !== "string") continue;
      const matches = await this.findByName(companyId, table, value);
      const exact = matches.filter((row) => row.names.some((name) => name.toLowerCase() === value.toLowerCase()));
      const chosen = matches.length === 1 ? matches[0] : exact.length === 1 ? exact[0] : undefined;
      if (chosen === undefined) {
        notes.push({ candidates: matches.slice(0, 5).map((row) => row.label), field, value });
        continue;
      }
      filters[filterKey] = chosen.id;
      chips.push({ field, filterKeys: [filterKey], value: chosen.label });
    }
    if (interpretation.deliveryStatuses.length > 0) {
      filters.deliveryStatus = interpretation.deliveryStatuses.join(",");
      chips.push({ field: "deliveryStatus", filterKeys: ["deliveryStatus"], value: filters.deliveryStatus });
    }
    if (interpretation.cashStatus !== null) {
      filters.cashStatus = interpretation.cashStatus;
      chips.push({ field: "cashStatus", filterKeys: ["cashStatus"], value: interpretation.cashStatus });
    }
    if (interpretation.settlementStatus !== null) {
      filters.settlementStatus = interpretation.settlementStatus;
      chips.push({ field: "settlementStatus", filterKeys: ["settlementStatus"], value: interpretation.settlementStatus });
    }
    if (interpretation.orderDateFrom !== null || interpretation.orderDateTo !== null) {
      if (interpretation.orderDateFrom !== null) filters.dateFrom = interpretation.orderDateFrom;
      if (interpretation.orderDateTo !== null) filters.dateTo = interpretation.orderDateTo;
      chips.push({
        field: "orderDate",
        filterKeys: ["dateFrom", "dateTo"],
        value: rangeText(interpretation.orderDateFrom, interpretation.orderDateTo),
      });
    }
    if (interpretation.deliveredFrom !== null || interpretation.deliveredTo !== null) {
      filters.quickView = "delivery";
      filters.deliveredOnly = "true";
      if (interpretation.deliveredFrom !== null) filters.deliveryDateFrom = interpretation.deliveredFrom;
      if (interpretation.deliveredTo !== null) filters.deliveryDateTo = interpretation.deliveredTo;
      chips.push({
        field: "deliveredDate",
        filterKeys: ["deliveredOnly", "deliveryDateFrom", "deliveryDateTo"],
        value: rangeText(interpretation.deliveredFrom, interpretation.deliveredTo),
      });
    }
    if (interpretation.search !== null) {
      filters.search = interpretation.search;
      chips.push({ field: "search", filterKeys: ["search"], value: interpretation.search });
    }
    if (interpretation.orderType !== null) {
      filters.orderType = interpretation.orderType;
      chips.push({ field: "orderType", filterKeys: ["orderType"], value: interpretation.orderType });
    }
    return { chips, filters, notes, source: "ai", unsupported: false };
  }

  private async findByName(
    companyId: string,
    table: NameTable,
    value: string,
  ): Promise<readonly { id: string; label: string; names: readonly string[] }[]> {
    const pattern = `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    // Emirates are shared reference data; only Emirates this Company has Areas
    // in are offered, so the answer stays inside the Company.
    const query =
      table === "emirates"
        ? sql<{ id: string; nameAr: string | null; nameEn: string }>`
            select e.id, e.name_en as "nameEn", e.name_ar as "nameAr" from emirates e
             where (e.name_en ilike ${pattern} or coalesce(e.name_ar, '') ilike ${pattern})
               and exists (select 1 from areas a where a.company_id = ${companyId}::uuid and a.emirate_id = e.id)
             order by e.name_en limit 6`
        : sql<{ id: string; nameAr: string | null; nameEn: string }>`
            select x.id, x.name_en as "nameEn", x.name_ar as "nameAr" from ${sql.table(table)} x
             where x.company_id = ${companyId}::uuid
               and (x.name_en ilike ${pattern} or coalesce(x.name_ar, '') ilike ${pattern})
             order by x.name_en limit 6`;
    const rows = (await query.execute(this.database)).rows;
    return rows.map((row) => ({
      id: row.id,
      label: row.nameAr !== null && row.nameAr.trim() !== "" && /[؀-ۿ]/u.test(value) ? row.nameAr : row.nameEn,
      names: [row.nameEn, row.nameAr ?? ""].filter((name) => name !== ""),
    }));
  }

  private async today(companyId: string): Promise<string> {
    const result = await sql<{ today: string }>`
      select (now() at time zone coalesce(
        (select timezone from company_settings where company_id = ${companyId}::uuid), 'Asia/Dubai'
      ))::date::text as today
    `.execute(this.database);
    return result.rows[0]?.today ?? new Date().toISOString().slice(0, 10);
  }
}

function rangeText(from: string | null, to: string | null): string {
  if (from !== null && to !== null) return from === to ? from : `${from} → ${to}`;
  return from !== null ? `≥ ${from}` : `≤ ${to ?? ""}`;
}
