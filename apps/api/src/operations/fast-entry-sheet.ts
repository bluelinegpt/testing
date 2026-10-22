import { strFromU8, unzipSync } from "fflate";

/**
 * Fast Order Entry -- the operators' own daily Excel sheet (Aiman, 22 Oct
 * 2026). Pure functions only: read the .xlsx, find the header row, and turn
 * each line into a draft Fast Entry row. Matching Traders, Areas and Drivers
 * against the Company happens in FastEntrySheetService; nothing here touches
 * the database.
 *
 * The daily sheet (e.g. "17-10-2026.xlsx") looks like:
 *   م | رقم الكوبون | الكود | اسم التاجر | المرسل الية | العنوان | رقم الهاتف |
 *   قيمة الطلبية | التوصيل | الاجمالى | ملاحظات | اسم المندوب | التاريخ | FX
 * with a title row above the header and a totals block below the orders.
 *
 * Money: التوصيل is the delivery fee, الاجمالى what the driver collects from
 * the customer (COD), and قيمة الطلبية what is left for the Trader. A
 * negative قيمة الطلبية (e.g. -25 / 25 / 0) means the customer pays less than
 * the fee and the Trader pays the rest: "Pay by Trader".
 */

// ---------------------------------------------------------------- xlsx reader

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Text of every <t> inside an XML fragment (rich text runs joined). */
function textRuns(xml: string): string {
  const parts: string[] = [];
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) parts.push(decodeXml(match[1] ?? ""));
  return parts.join("");
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase() ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export class SheetReadError extends Error {}

/**
 * The first worksheet of an .xlsx file as rows of cell text. Numbers keep
 * their stored form ("556351489", "-25", "20.5"); empty cells are "".
 */
export function readXlsxRows(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SheetReadError("not_xlsx");
  }
  const text = (name: string) => (files[name] === undefined ? undefined : strFromU8(files[name]!));
  const workbook = text("xl/workbook.xml");
  if (workbook === undefined) throw new SheetReadError("not_xlsx");
  // First sheet in the workbook's own order, resolved through its relationship.
  const firstSheetRelationship = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const relationships = text("xl/_rels/workbook.xml.rels") ?? "";
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (firstSheetRelationship !== undefined) {
    const target = new RegExp(
      `<Relationship\\b[^>]*\\bId="${firstSheetRelationship}"[^>]*\\bTarget="([^"]+)"`,
    ).exec(relationships)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheetRelationship}"`).exec(
        relationships,
      )?.[1];
    if (target !== undefined) {
      sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    }
  }
  const sheet = text(sheetPath);
  if (sheet === undefined) throw new SheetReadError("no_sheet");
  const sharedXml = text("xl/sharedStrings.xml") ?? "";
  const shared: string[] = [];
  const sharedPattern = /<si>([\s\S]*?)<\/si>/g;
  let sharedMatch: RegExpExecArray | null;
  while ((sharedMatch = sharedPattern.exec(sharedXml)) !== null) shared.push(textRuns(sharedMatch[1] ?? ""));

  const rows: string[][] = [];
  const rowPattern = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(sheet)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    const body = rowMatch[1] ?? "";
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const attributes = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const index = reference === undefined ? cells.length : columnIndex(reference);
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: string;
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textRuns(inner);
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else value = raw === undefined ? "" : decodeXml(raw);
      while (cells.length < index) cells.push("");
      cells[index] = value.trim();
    }
    rows.push(cells);
  }
  return rows;
}

// ------------------------------------------------------------ normalisation

/** Arabic/English name key: hamza forms, ta marbuta, alef maqsura, case, spaces. */
export function nameKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[ً-ْـ]/g, "") // harakat and tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ء/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ----------------------------------------------------------- sheet columns

type SheetColumn =
  | "address"
  | "customer"
  | "driver"
  | "fee"
  | "notes"
  | "orderValue"
  | "phone"
  | "reference"
  | "total"
  | "trader";

const HEADER_ALIASES: Readonly<Record<SheetColumn, readonly string[]>> = {
  address: ["العنوان", "المنطقه", "المنطقه العنوان", "address", "area", "area address"],
  customer: ["المرسل اليه", "المرسل الية", "المرسل اليه", "اسم العميل", "العميل", "customer", "customer name"],
  driver: ["اسم المندوب", "المندوب", "السائق", "driver", "driver name"],
  fee: ["التوصيل", "رسوم التوصيل", "delivery fee", "delivery", "service fee"],
  notes: ["ملاحظات", "notes", "note"],
  orderValue: ["قيمه الطلبيه", "قيمه الطلب", "order value", "order value to trader", "value"],
  phone: ["رقم الهاتف", "الهاتف", "رقم الجوال", "الجوال", "mobile", "phone", "mobile number"],
  reference: ["رقم الكوبون", "رقم المرجع", "الرقم المرجعي", "المرجع", "reference number", "reference", "coupon"],
  total: ["الاجمالي", "الاجمالى", "المبلغ المطلوب", "total", "total cod", "cod"],
  trader: ["اسم التاجر", "التاجر", "trader", "trader name"],
};
const headerKeys = new Map<string, SheetColumn>();
for (const [column, aliases] of Object.entries(HEADER_ALIASES) as [SheetColumn, readonly string[]][]) {
  for (const alias of aliases) headerKeys.set(nameKey(alias), column);
}

/** Words that mark a line as returned or cancelled: shown red, never loaded. */
const EXCLUDE_MARKERS = ["رجعت", "راجع", "مرتجع", "كنسل", "ملغي", "ملغى", "الغاء", "cancel", "cancelled", "returned"].map(nameKey);

export interface SheetMessage {
  readonly ar: string;
  readonly en: string;
}

export interface ParsedSheetRow {
  /** 1-based row number in the sheet, for messages. */
  readonly sheetRow: number;
  readonly referenceNumber: string;
  readonly traderName: string;
  readonly customerName: string;
  readonly mobile: string;
  readonly secondMobile: string;
  readonly addressText: string;
  readonly driverName: string;
  readonly notes: string;
  readonly packageCount: number;
  /** What the driver collects from the customer (الاجمالى). */
  readonly codAmount: number | null;
  /** The delivery fee written on the sheet (التوصيل). */
  readonly sheetFee: number | null;
  readonly paymentCondition: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";
  readonly errors: readonly SheetMessage[];
  /** Returned / cancelled line: listed in red and not loaded. */
  readonly excludedReason: SheetMessage | null;
}

export interface ParsedSheet {
  readonly rows: readonly ParsedSheetRow[];
  readonly headerFound: boolean;
}

function toNumber(value: string | undefined): number | null {
  const cleaned = (value ?? "").replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

/** "556351489" -> "0556351489"; "(+)639156022976" -> "+639156022976"; "0" -> "". */
export function sheetMobile(value: string): string {
  const trimmed = value.replace(/\(\+\)/g, "+").replace(/\s+/g, "").trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits === "" || /^0+$/.test(digits)) return "";
  if (plus) return `+${digits}`;
  if (/^5\d{8}$/.test(digits)) return `0${digits}`;
  return digits;
}

function splitMobiles(value: string): [string, string] {
  // "554451755-553932609", "541751085-(+)639567487403", "585223488/507773990"
  const parts = value
    .split(/[-/،,]|\s{2,}/)
    .map(sheetMobile)
    .filter((part) => part !== "");
  return [parts[0] ?? "", parts[1] ?? ""];
}

function packagesFrom(notes: string): number {
  const match = /(\d+)\s*(?:قطعه|قطعة|قطع|pcs|pieces|pc)/i.exec(notes);
  const count = match === null ? 1 : Number(match[1]);
  return Number.isInteger(count) && count > 0 && count < 1000 ? count : 1;
}

const money = (value: number) => Math.round(value * 100) / 100;

/** Finds the header row and turns every order line into a draft row. */
export function parseFastEntrySheet(rows: readonly (readonly string[])[]): ParsedSheet {
  let headerIndex = -1;
  let columns = new Map<SheetColumn, number>();
  for (let index = 0; index < Math.min(rows.length, 15); index += 1) {
    const found = new Map<SheetColumn, number>();
    (rows[index] ?? []).forEach((cell, cellIndex) => {
      const column = headerKeys.get(nameKey(cell));
      if (column !== undefined && !found.has(column)) found.set(column, cellIndex);
    });
    if (found.has("reference") && found.has("trader")) {
      headerIndex = index;
      columns = found;
      break;
    }
  }
  if (headerIndex < 0) return { headerFound: false, rows: [] };
  // The 18-10 sheet left the Notes header blank: the column after the total.
  const totalColumn = columns.get("total");
  if (!columns.has("notes") && totalColumn !== undefined) columns.set("notes", totalColumn + 1);
  // The 17-10 sheet left the phone header blank: the column after the address.
  const addressColumn = columns.get("address");
  if (!columns.has("phone") && addressColumn !== undefined && (rows[headerIndex]?.[addressColumn + 1] ?? "").trim() === "") {
    columns.set("phone", addressColumn + 1);
  }

  const cell = (row: readonly string[], column: SheetColumn) => {
    const index = columns.get(column);
    return index === undefined ? "" : (row[index] ?? "").trim();
  };
  const parsed: ParsedSheetRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const reference = cell(row, "reference");
    const trader = cell(row, "trader");
    const addressText = cell(row, "address");
    const phoneText = cell(row, "phone");
    // The totals block under the orders ("الاجمالى / المسلم / الراجع") and
    // blank lines are not orders.
    if (nameKey(trader) === nameKey("الاجمالى") || nameKey(trader) === "total") break;
    if (reference === "" && trader === "" && addressText === "" && phoneText === "") continue;

    const value = toNumber(cell(row, "orderValue"));
    const fee = toNumber(cell(row, "fee"));
    let total = toNumber(cell(row, "total"));
    if (total === null && value !== null && fee !== null) total = value + fee;
    const notes = cell(row, "notes");
    const [mobile, secondMobile] = splitMobiles(phoneText);
    const errors: SheetMessage[] = [];
    const referenceClean = reference.replace(/\s+/g, "");
    // A blank or "***" reference is allowed: the order is then known by its Order Number.
    if (trader === "") errors.push({ ar: "اسم التاجر غير موجود", en: "Trader name is missing" });
    if (mobile === "") errors.push({ ar: "رقم الهاتف غير موجود", en: "Mobile number is missing" });
    if (fee === null || total === null) {
      errors.push({ ar: "المبالغ غير مكتملة (التوصيل / الاجمالى)", en: "Amounts are incomplete (fee / total)" });
    }
    // Returned / cancelled anywhere on the line (driver column, date column,
    // notes): listed in red, never loaded.
    const excluded = row.some((value) => {
      const key = nameKey(value);
      return key !== "" && EXCLUDE_MARKERS.some((marker) => key === marker || key.split(" ").includes(marker));
    });
    const cod = total === null ? null : money(Math.max(total, 0));
    const traderPays = fee !== null && total !== null && total < fee;
    parsed.push({
      addressText,
      codAmount: cod,
      customerName: cell(row, "customer") || "عميل",
      driverName: cell(row, "driver"),
      errors,
      excludedReason: excluded
        ? { ar: "مرتجع أو ملغى في الكشف — لن يتم تحميله", en: "Returned or cancelled on the sheet — not loaded" }
        : null,
      mobile,
      notes,
      packageCount: packagesFrom(notes),
      paymentCondition: traderPays ? "customer_pays_cod_trader_pays_fee" : "customer_pays_cod_and_fee",
      referenceNumber: /^\*+$/.test(referenceClean) ? "" : referenceClean,
      secondMobile,
      sheetFee: fee === null ? null : money(fee),
      sheetRow: index + 1,
      traderName: trader,
    });
  }
  // The same reference twice in one sheet.
  const counts = new Map<string, number>();
  for (const row of parsed) {
    if (row.referenceNumber !== "" && row.excludedReason === null) {
      counts.set(row.referenceNumber, (counts.get(row.referenceNumber) ?? 0) + 1);
    }
  }
  return {
    headerFound: true,
    rows: parsed.map((row) =>
      row.referenceNumber !== "" && (counts.get(row.referenceNumber) ?? 0) > 1
        ? {
            ...row,
            errors: [
              ...row.errors,
              { ar: "رقم المرجع مكرر في الكشف", en: "Reference number appears twice in the sheet" },
            ],
          }
        : row,
    ),
  };
}

// ------------------------------------------------------------------- areas

export interface SheetEmirate {
  readonly id: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
}

/** Short forms operators write in front of an Area: "ش السيوح", "راك الظيت". */
const EMIRATE_PREFIXES: readonly (readonly [string, string])[] = [
  ["ش", "sharjah"],
  ["الشارقه", "sharjah"],
  ["راك", "ras al khaimah"],
  ["راس الخيمه", "ras al khaimah"],
  ["الفجيره", "fujairah"],
  ["عجمان", "ajman"],
  ["ابوظبي", "abu dhabi"],
  ["ابو ظبي", "abu dhabi"],
  ["دبي", "dubai"],
  ["العين", "al ain"],
  ["ع", "al ain"],
  // "ديره المرر": Deira is in Dubai; the Area follows.
  ["ديره", "dubai"],
  ["ام القيوين", "umm al quwain"],
];

/** Splits "ش السيوح" into the Emirate (English name key) and the Area text. */
export function splitEmiratePrefix(text: string): { emirate: string | null; area: string } {
  const key = nameKey(text);
  for (const [prefix, emirate] of EMIRATE_PREFIXES) {
    const prefixKey = nameKey(prefix);
    if (key === prefixKey) return { area: "", emirate };
    if (key.startsWith(`${prefixKey} `)) return { area: key.slice(prefixKey.length + 1), emirate };
  }
  return { area: key, emirate: null };
}
