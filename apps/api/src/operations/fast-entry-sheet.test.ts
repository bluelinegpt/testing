import { describe, expect, it } from "vitest";

import { accountingXlsx } from "../accounting/accounting-xlsx.js";

import { nameKey, parseFastEntrySheet, readXlsxRows, splitEmiratePrefix } from "./fast-entry-sheet.js";
import { FastEntrySheetService, matchFastEntryRows, type FastEntrySheetArea } from "./fast-entry-sheet.service.js";

const header = ["م", "رقم الكوبون", "الكود", "اسم التاجر", "المرسل الية", "العنوان", "رقم الهاتف", "قيمة الطلبية", "التوصيل", "الاجمالى", "ملاحظات", "اسم المندوب"];
const sheet = (lines: readonly (readonly unknown[])[]) =>
  readXlsxRows(
    new Uint8Array(
      accountingXlsx(header, lines.map((line) => Object.fromEntries(header.map((column, index) => [column, line[index] ?? ""]))), [["كشف 18-10-2026", ""]]),
    ),
  );

const area = (id: string, nameAr: string, emirateId: string, emirateNameAr: string, emirateNameEn: string): FastEntrySheetArea => ({
  code: id, emirateCode: "", emirateId, emirateNameAr, emirateNameEn, id, isActive: true, nameAr, nameEn: id, notes: null, updatedAt: "",
});
const trader = (id: string, nameEn: string) => ({
  code: id, id, mobileNumber: "", nameAr: null, nameEn, pickupAreaId: null, pickupAreaNameAr: null, pickupAreaNameEn: null,
  pickupEmirateId: null, pickupEmirateNameAr: null, pickupEmirateNameEn: null, secondMobileNumber: null,
});
const directory = {
  areas: [
    area("taawun", "التعاون", "shj", "الشارقة", "Sharjah"),
    area("bahia-auh", "الباهية", "auh", "أبوظبي", "Abu Dhabi"),
    area("bahia-ajm", "الباهية", "ajm", "عجمان", "Ajman"),
    area("barsha", "البرشاء", "dxb", "دبي", "Dubai"),
    area("zahia", "الزاهية", "auh", "أبوظبي", "Abu Dhabi"),
  ],
  drivers: [{ id: "driver-1", nameAr: null, nameEn: "مجدي" }],
  traders: [trader("t1", "Plaza Store"), trader("t2", "ملابس عادل"), trader("t3", "ملابس عادل")],
};

describe("Fast Entry daily sheet", () => {
  it("normalises Arabic names so spelling variants match", () => {
    expect(nameKey("البرشاء")).toBe(nameKey("البرشا"));
    expect(nameKey("الشارقة")).toBe(nameKey("الشارقه"));
    expect(nameKey("أبوظبي")).toBe(nameKey("ابوظبي"));
    expect(splitEmiratePrefix("ش التعاون")).toEqual({ area: "التعاون", emirate: "sharjah" });
  });

  it("reads the sheet, keeps blank references, and marks returned lines", () => {
    const parsed = parseFastEntrySheet(
      sheet([
        [1, "17330", "", "Plaza Store", "احمد", "ش التعاون", "0501234567", 100, 25, 125, "2 قطعه", "مجدي"],
        [2, "***", "", "Plaza Store", "", "البرشا", "501234568", -25, 25, 0, "", "خارج"],
        [3, "17331", "", "Plaza Store", "", "الباهيه", "0501234569", 50, 20, 70, "رجعت", ""],
      ]),
    );
    expect(parsed.headerFound).toBe(true);
    expect(parsed.rows).toHaveLength(3);
    const [first, second, third] = parsed.rows;
    expect(first).toMatchObject({ codAmount: 125, packageCount: 2, paymentCondition: "customer_pays_cod_and_fee", sheetFee: 25 });
    expect(second).toMatchObject({ codAmount: 0, errors: [], mobile: "0501234568", paymentCondition: "customer_pays_cod_trader_pays_fee", referenceNumber: "" });
    expect(third?.excludedReason).not.toBeNull();
  });

  it("matches Traders, Areas and Drivers, and explains what it could not match", () => {
    const parsed = parseFastEntrySheet(
      sheet([
        [1, "1", "", "plaza store", "", "ش التعاون", "0501234567", 100, 25, 125, "", "مجدي"],
        [2, "2", "", "ملابس عادل", "", "البرشا", "0501234568", 100, 25, 125, "", "خارج"],
        [3, "3", "", "New Shop", "", "الباهيه", "0501234569", 100, 25, 125, "", ""],
        [4, "4", "", "Plaza Store", "", "ابوظبي", "0501234560", 100, 25, 125, "", ""],
      ]),
    );
    const { rows } = matchFastEntryRows(parsed.rows, directory);
    expect(rows[0]).toMatchObject({ area: { id: "taawun" }, driverId: "driver-1", errors: [], trader: { id: "t1" } });
    expect(rows[1]).toMatchObject({ area: { id: "barsha" }, driverId: null, trader: null });
    expect(rows[1]?.errors.map((error) => error.en)).toEqual([expect.stringContaining("More than one Trader")]);
    expect(rows[2]?.errors.map((error) => error.en)).toEqual([
      expect.stringContaining('Trader "New Shop" not found'),
      expect.stringContaining("more than one Emirate"),
    ]);
    expect(rows[3]).toMatchObject({ area: null, emirateId: "auh" });
    expect(rows[3]?.errors[0]?.ar).toContain("اسم إمارة فقط");
  });

  it("finds an Area named after the Emirate prefix in another Emirate, and says so", () => {
    const parsed = parseFastEntrySheet(
      sheet([[1, "1", "", "Plaza Store", "", "ش الزاهيه", "0501234567", 100, 25, 125, "احضار", ""]]),
    );
    const [row] = matchFastEntryRows(parsed.rows, directory).rows;
    expect(row).toMatchObject({ area: { id: "zahia" }, emirateId: "auh", pickup: true });
    expect(row?.areaNote?.en).toContain("Abu Dhabi");
    expect(row?.errors).toEqual([]);
  });

  it("gives every line to the signed-in Trader in the portal, with no Driver", () => {
    const parsed = parseFastEntrySheet(
      sheet([
        [1, "1", "", "Someone Else", "", "ش التعاون", "0501234567", 100, 25, 125, "", "مجدي"],
        [2, "2", "", "", "", "ش التعاون", "0501234568", 100, 25, 125, "", ""],
      ]),
    );
    const me = trader("me", "My Shop");
    const { rows } = matchFastEntryRows(parsed.rows, { ...directory, drivers: [], traders: [] }, me);
    expect(rows.map((row) => row.trader?.id)).toEqual(["me", "me"]);
    expect(rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(rows.map((row) => [row.driverId, row.driverName])).toEqual([[null, ""], [null, ""]]);
  });

  it("downloads a template the importer reads back, in Arabic and English", () => {
    const service = new FastEntrySheetService(undefined as never, undefined as never);
    for (const language of ["ar", "en"] as const) {
      const file = service.template(language);
      const parsed = parseFastEntrySheet(readXlsxRows(new Uint8Array(file.bytes)));
      expect(parsed.headerFound).toBe(true);
      expect(parsed.rows).toHaveLength(0);
    }
  });
});
