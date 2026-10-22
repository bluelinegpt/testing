import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { accountingXlsx } from "../accounting/accounting-xlsx.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import {
  nameKey,
  parseFastEntrySheet,
  readXlsxRows,
  SheetReadError,
  splitEmiratePrefix,
  type ParsedSheetRow,
  type SheetMessage,
} from "./fast-entry-sheet.js";

export interface FastEntrySheetArea {
  readonly code: string;
  readonly emirateCode: string;
  readonly emirateId: string;
  readonly emirateNameAr: string;
  readonly emirateNameEn: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly notes: string | null;
  readonly updatedAt: string;
}

export interface FastEntrySheetTrader {
  readonly code: string;
  readonly id: string;
  readonly mobileNumber: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly pickupAreaId: null;
  readonly pickupAreaNameAr: null;
  readonly pickupAreaNameEn: null;
  readonly pickupEmirateId: null;
  readonly pickupEmirateNameAr: null;
  readonly pickupEmirateNameEn: null;
  readonly secondMobileNumber: null;
}

/** One sheet line, matched against the Company -- a draft Fast Entry row. */
export interface FastEntrySheetRow {
  readonly sheetRow: number;
  readonly referenceNumber: string;
  readonly sheetTraderName: string;
  readonly trader: FastEntrySheetTrader | null;
  readonly customerName: string;
  readonly mobile: string;
  readonly secondMobile: string;
  readonly emirateId: string;
  readonly area: FastEntrySheetArea | null;
  /** The Area was matched in another Emirate than the sheet's prefix said. */
  readonly areaNote: SheetMessage | null;
  readonly pickup: boolean;
  readonly customerAddress: string;
  readonly codAmount: string;
  /** The delivery fee written on the sheet; split against the Trader's price on validation. */
  readonly sheetServiceFee: string | null;
  readonly paymentCondition: ParsedSheetRow["paymentCondition"];
  readonly packageCount: number;
  readonly notes: string;
  readonly driverId: string | null;
  readonly driverName: string;
  readonly errors: readonly SheetMessage[];
  readonly excludedReason: SheetMessage | null;
}

export interface FastEntrySheetResult {
  readonly rows: readonly FastEntrySheetRow[];
  readonly totalLines: number;
  readonly excludedLines: number;
}

const TEMPLATE_COLUMNS = {
  ar: ["م", "رقم الكوبون", "اسم التاجر", "المرسل اليه", "العنوان", "رقم الهاتف", "قيمة الطلبية", "التوصيل", "الاجمالى", "ملاحظات", "اسم المندوب"],
  en: ["No", "Reference Number", "Trader Name", "Customer Name", "Area / Address", "Mobile", "Order Value (to Trader)", "Delivery Fee", "Total (COD)", "Notes", "Driver"],
} as const;

const TEMPLATE_NOTES = {
  ar: [
    ["كشف الطلبات اليومي", ""],
    ["الاجمالى", "المبلغ الذي يحصّله المندوب من العميل"],
    ["التوصيل", "رسوم التوصيل"],
    ["قيمة الطلبية", "الاجمالى − التوصيل. إذا كانت بالسالب (مثال −25 / 25 / 0) فالدفع من التاجر"],
    ["العنوان", "اسم المنطقة، ويمكن كتابة الإمارة قبلها: ش التعاون، راك الظيت، الفجيره الفصيل"],
    ["الملاحظات", "اكتب «2 قطعه» لعدد الطرود، و«رجعت» أو «كنسل» لطلب لا يُحمّل"],
  ],
  en: [
    ["Daily orders sheet", ""],
    ["Total (COD)", "What the driver collects from the customer"],
    ["Delivery Fee", "The delivery fee"],
    ["Order Value (to Trader)", "Total − Delivery Fee. Negative (e.g. −25 / 25 / 0) means the Trader pays"],
    ["Area / Address", "The Area name; the Emirate may come first: ش التعاون, راك الظيت, الفجيره الفصيل"],
    ["Notes", "Write \"2 pcs\" for packages, and \"returned\" or \"cancelled\" for a line not to load"],
  ],
} as const;

@Injectable()
export class FastEntrySheetService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /** An empty sheet in the same layout the importer reads (Arabic or English headers). */
  public template(language: "ar" | "en"): { bytes: Buffer; filename: string } {
    const columns = TEMPLATE_COLUMNS[language];
    const bytes = accountingXlsx(columns, [], TEMPLATE_NOTES[language]);
    return {
      bytes,
      filename: language === "ar" ? "Fast-Entry-Template-AR.xlsx" : "Fast-Entry-Template-EN.xlsx",
    };
  }

  /**
   * Trader portal: the same sheet, for the signed-in Trader. Every line is his
   * (the sheet's Trader column is ignored) and no Driver is assigned.
   */
  public async loadForTrader(
    file: { readonly buffer: Buffer; readonly originalname: string } | undefined,
    trader: { readonly code: string; readonly id: string; readonly mobileNumber: string; readonly nameAr: string | null; readonly nameEn: string },
  ): Promise<FastEntrySheetResult> {
    return this.load(file, {
      code: trader.code,
      id: trader.id,
      mobileNumber: trader.mobileNumber,
      nameAr: trader.nameAr,
      nameEn: trader.nameEn,
      pickupAreaId: null,
      pickupAreaNameAr: null,
      pickupAreaNameEn: null,
      pickupEmirateId: null,
      pickupEmirateNameAr: null,
      pickupEmirateNameEn: null,
      secondMobileNumber: null,
    });
  }

  public async load(
    file: { readonly buffer: Buffer; readonly originalname: string } | undefined,
    fixedTrader?: FastEntrySheetTrader,
  ): Promise<FastEntrySheetResult> {
    if (file === undefined || file.buffer.length === 0) {
      throw new ApplicationException("fast_entry_sheet_missing", "Choose an Excel file (.xlsx)", HttpStatus.BAD_REQUEST);
    }
    let raw: string[][];
    try {
      raw = readXlsxRows(new Uint8Array(file.buffer));
    } catch (error) {
      if (error instanceof SheetReadError) {
        throw new ApplicationException(
          "fast_entry_sheet_unreadable",
          "The file is not an Excel workbook (.xlsx) / الملف ليس ملف إكسل (.xlsx)",
          HttpStatus.BAD_REQUEST,
        );
      }
      throw error;
    }
    const parsed = parseFastEntrySheet(raw);
    if (!parsed.headerFound) {
      throw new ApplicationException(
        "fast_entry_sheet_header_missing",
        "The header row was not found: the sheet needs at least \"Reference Number\" and \"Trader Name\" columns / لم يتم العثور على صف العناوين: يجب أن يحتوي الكشف على عمودي «رقم الكوبون» و«اسم التاجر»",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { companyId } = this.tenants.current();
    const [traders, areas, drivers] = await Promise.all([
      this.traders(companyId),
      this.areas(companyId),
      this.drivers(companyId),
    ]);

    return fixedTrader === undefined
      ? matchFastEntryRows(parsed.rows, { areas, drivers, traders })
      : matchFastEntryRows(parsed.rows, { areas, drivers: [], traders: [] }, fixedTrader);
  }

  private async traders(companyId: string): Promise<FastEntrySheetTrader[]> {
    const result = await sql<{ code: string; id: string; mobileNumber: string; nameAr: string | null; nameEn: string }>`
      select id, code, name_en as "nameEn", name_ar as "nameAr", coalesce(mobile_number, '') as "mobileNumber"
        from traders
       where company_id = ${companyId}::uuid and account_status = 'active'
    `.execute(this.database);
    return result.rows.map((row) => ({
      ...row,
      pickupAreaId: null,
      pickupAreaNameAr: null,
      pickupAreaNameEn: null,
      pickupEmirateId: null,
      pickupEmirateNameAr: null,
      pickupEmirateNameEn: null,
      secondMobileNumber: null,
    }));
  }

  private async areas(companyId: string): Promise<FastEntrySheetArea[]> {
    const result = await sql<FastEntrySheetArea>`
      select a.id, a.code, a.name_en as "nameEn", a.name_ar as "nameAr", a.emirate_id as "emirateId",
             coalesce(e.code, '') as "emirateCode", e.name_en as "emirateNameEn",
             coalesce(e.name_ar, e.name_en) as "emirateNameAr", a.is_active as "isActive",
             a.notes, a.updated_at::text as "updatedAt"
        from areas a
        join emirates e on e.id = a.emirate_id
       where a.company_id = ${companyId}::uuid and a.is_active
    `.execute(this.database);
    return result.rows;
  }

  private async drivers(companyId: string): Promise<{ id: string; nameAr: string | null; nameEn: string }[]> {
    const result = await sql<{ id: string; nameAr: string | null; nameEn: string }>`
      select id, name_en as "nameEn", name_ar as "nameAr"
        from drivers
       where company_id = ${companyId}::uuid and account_status = 'active'
    `.execute(this.database);
    return result.rows;
  }
}

export interface FastEntryDirectory {
  readonly areas: readonly FastEntrySheetArea[];
  readonly drivers: readonly { readonly id: string; readonly nameAr: string | null; readonly nameEn: string }[];
  readonly traders: readonly FastEntrySheetTrader[];
}

/** Matches parsed sheet lines to the Company's active Traders, Areas and Drivers. Pure, for tests. */
export function matchFastEntryRows(
  parsedRows: readonly ParsedSheetRow[],
  { areas, drivers, traders }: FastEntryDirectory,
  /** Trader portal: every line belongs to this Trader; the sheet's Trader is ignored. */
  fixedTrader?: FastEntrySheetTrader,
): FastEntrySheetResult {
  const tradersByKey = new Map<string, FastEntrySheetTrader[]>();
  for (const trader of traders) {
    for (const key of new Set([nameKey(trader.nameEn), nameKey(trader.nameAr)])) {
      if (key === "") continue;
      tradersByKey.set(key, [...(tradersByKey.get(key) ?? []), trader]);
    }
  }
  const driversByKey = new Map<string, string[]>();
  for (const driver of drivers) {
    for (const key of new Set([nameKey(driver.nameEn), nameKey(driver.nameAr)])) {
      if (key === "") continue;
      driversByKey.set(key, [...(driversByKey.get(key) ?? []), driver.id]);
    }
  }
  const areaKey = (value: string | null) => nameKey(value);
  const emirateKeys = new Map<string, string>(); // name key -> emirate id
  for (const area of areas) {
    emirateKeys.set(nameKey(area.emirateNameEn), area.emirateId);
    emirateKeys.set(nameKey(area.emirateNameAr), area.emirateId);
  }

  const rows = parsedRows.map((row): FastEntrySheetRow => {
    // Trader portal: the sheet's Trader column does not apply.
    const errors: SheetMessage[] =
      fixedTrader === undefined
        ? [...row.errors]
        : row.errors.filter((error) => error.en !== "Trader name is missing");
    // Trader
    const traderMatches =
      fixedTrader !== undefined || row.traderName === ""
        ? []
        : (tradersByKey.get(nameKey(row.traderName)) ?? []);
    let trader: FastEntrySheetTrader | null = fixedTrader ?? null;
    if (fixedTrader !== undefined) {
      // nothing to match
    } else if (traderMatches.length === 1) trader = traderMatches[0]!;
    else if (traderMatches.length > 1) {
      errors.push({
        ar: `يوجد أكثر من تاجر باسم «${row.traderName}» — اختر التاجر`,
        en: `More than one Trader is named "${row.traderName}" — choose the Trader`,
      });
    } else if (row.traderName !== "") {
      errors.push({
        ar: `التاجر «${row.traderName}» غير موجود — أضفه أو اختره`,
        en: `Trader "${row.traderName}" not found — add or choose the Trader`,
      });
    }
    // Area: "ش السيوح" -> Sharjah / السيوح; "ابوظبي" alone -> Emirate only.
    const { area: areaText, emirate: prefixEmirate } = splitEmiratePrefix(row.addressText);
    const prefixEmirateId = prefixEmirate === null ? undefined : emirateKeys.get(nameKey(prefixEmirate));
    const wholeTextEmirateId = emirateKeys.get(nameKey(row.addressText));
    let area: FastEntrySheetArea | null = null;
    let areaNote: SheetMessage | null = null;
    let emirateId = prefixEmirateId ?? wholeTextEmirateId ?? "";
    const lookup = (text: string, onlyEmirate?: string) =>
      areas.filter(
        (candidate) =>
          (onlyEmirate === undefined || candidate.emirateId === onlyEmirate) &&
          (areaKey(candidate.nameAr) === areaKey(text) || areaKey(candidate.nameEn) === areaKey(text)),
      );
    if (row.addressText === "") {
      errors.push({ ar: "المنطقة غير موجودة في الكشف", en: "Area is missing on the sheet" });
    } else if (wholeTextEmirateId !== undefined && lookup(row.addressText).length === 0) {
      errors.push({
        ar: `«${row.addressText}» اسم إمارة فقط — اختر المنطقة`,
        en: `"${row.addressText}" is an Emirate only — choose the Area`,
      });
    } else {
      let candidates = areaText === "" ? [] : lookup(areaText, prefixEmirateId);
      // "الفجيره السيوح" may also be an Area's full name.
      if (candidates.length === 0) candidates = lookup(row.addressText);
      // "ش الزاهيه": no الزاهيه in Sharjah, so look for الزاهيه in every
      // Emirate (Aiman, 22 Oct 2026). A match elsewhere is used, with a note.
      let otherEmirate = false;
      if (candidates.length === 0 && prefixEmirateId !== undefined && areaText !== "") {
        candidates = lookup(areaText);
        otherEmirate = candidates.length > 0;
      }
      if (candidates.length === 1) {
        area = candidates[0]!;
        emirateId = area.emirateId;
        if (otherEmirate) {
          areaNote = {
            ar: `المنطقة «${areaText}» موجودة في ${area.emirateNameAr} وليس كما في الكشف — تحقق منها`,
            en: `Area "${areaText}" was found in ${area.emirateNameEn}, not the Emirate on the sheet — please check`,
          };
        }
      } else if (candidates.length > 1) {
        const emirates = new Set(candidates.map((candidate) => candidate.emirateId));
        if (emirates.size === 1) {
          emirateId = candidates[0]!.emirateId;
          errors.push({
            ar: `يوجد أكثر من منطقة باسم «${row.addressText}» — اختر المنطقة`,
            en: `More than one Area is named "${row.addressText}" — choose the Area`,
          });
        } else {
          errors.push({
            ar: `المنطقة «${row.addressText}» موجودة في أكثر من إمارة — اختر المنطقة`,
            en: `Area "${row.addressText}" exists in more than one Emirate — choose the Area`,
          });
        }
      } else {
        errors.push({
          ar: `المنطقة «${row.addressText}» غير موجودة — اختر المنطقة`,
          en: `Area "${row.addressText}" not found — choose the Area`,
        });
      }
    }
    // Driver: assigned only when the name is exactly one of the Company's
    // Drivers; zones such as خارج / داخل are left for later.
    const driverMatches = row.driverName === "" ? [] : (driversByKey.get(nameKey(row.driverName)) ?? []);
    return {
      area,
      areaNote,
      // "احضار": a pickup line on the operators' sheet.
      pickup: nameKey(row.notes).includes(nameKey("احضار")),
      codAmount: row.codAmount === null ? "" : row.codAmount.toFixed(2),
      customerAddress: row.addressText,
      customerName: row.customerName,
      driverId: fixedTrader === undefined && driverMatches.length === 1 ? driverMatches[0]! : null,
      // A Trader does not assign Drivers.
      driverName: fixedTrader === undefined ? row.driverName : "",
      emirateId,
      errors,
      excludedReason: row.excludedReason,
      mobile: row.mobile,
      notes: row.notes,
      packageCount: row.packageCount,
      paymentCondition: row.paymentCondition,
      referenceNumber: row.referenceNumber,
      secondMobile: row.secondMobile,
      sheetRow: row.sheetRow,
      sheetServiceFee: row.sheetFee === null ? null : row.sheetFee.toFixed(2),
      sheetTraderName: row.traderName,
      trader,
    };
  });
  return {
    excludedLines: rows.filter((row) => row.excludedReason !== null).length,
    rows,
    totalLines: rows.length,
  };
}
