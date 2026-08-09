export type NumericInputError = "invalid" | "negative" | "precision" | "too_large" | "whole_number";

export type NumericInputResult =
  | { readonly ok: true; readonly normalized: string; readonly value: number }
  | { readonly error: NumericInputError; readonly ok: false };

export interface NumericInputOptions {
  readonly allowNegative?: boolean;
  readonly allowZero?: boolean;
  readonly decimalPlaces?: number;
  readonly maxAbsolute?: number;
  readonly required?: boolean | undefined;
  readonly wholeNumber?: boolean;
}

const arabicDigits: Readonly<Record<string, string>> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

function normalizeCharacters(raw: string): string {
  return [...raw]
    .map((character) => arabicDigits[character] ?? character)
    .join("")
    .trim()
    .replaceAll(/\s/g, "")
    .replaceAll("٫", ".")
    .replaceAll(/[٬,]/g, "")
    .replaceAll(/AED/gi, "")
    .replaceAll(/د\.?إ\.?/g, "")
    .replaceAll(/\p{Sc}/gu, "");
}

export function parseNumericInput(
  raw: string | number | null | undefined,
  options: NumericInputOptions = {},
): NumericInputResult {
  const value = normalizeCharacters(String(raw ?? ""));
  if (value === "") {
    return options.required === true
      ? { error: "invalid", ok: false }
      : { normalized: "0", ok: true, value: 0 };
  }
  const candidate = value.startsWith(".")
    ? `0${value}`
    : value.startsWith("-.")
      ? value.replace("-.", "-0.")
      : value;
  if (!/^-?\d+(?:\.\d+)?$/.test(candidate)) return { error: "invalid", ok: false };
  if (candidate.startsWith("-") && options.allowNegative !== true) {
    return { error: "negative", ok: false };
  }
  const decimals = candidate.split(".")[1]?.length ?? 0;
  if (options.wholeNumber === true && decimals > 0) {
    return { error: "whole_number", ok: false };
  }
  if (decimals > (options.decimalPlaces ?? 2)) {
    return { error: "precision", ok: false };
  }
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric)) return { error: "too_large", ok: false };
  if (numeric === 0 && options.allowZero === false) {
    return { error: "invalid", ok: false };
  }
  const maximum = options.maxAbsolute ?? 9_999_999_999_999.99;
  if (Math.abs(numeric) > maximum) return { error: "too_large", ok: false };
  return { normalized: candidate, ok: true, value: numeric };
}

export function parseMoneyInput(
  raw: string | number | null | undefined,
  options: Omit<NumericInputOptions, "decimalPlaces" | "wholeNumber"> = {},
): NumericInputResult {
  return parseNumericInput(raw, { ...options, decimalPlaces: 2 });
}

export function safeNumericValue(raw: string | number | null | undefined, fallback = 0): number {
  const parsed = parseNumericInput(raw, { allowNegative: true, decimalPlaces: 6 });
  return parsed.ok ? parsed.value : fallback;
}

export function safeMoneyValue(raw: string | number | null | undefined, fallback = 0): number {
  const parsed = parseMoneyInput(raw, { allowNegative: true });
  return parsed.ok ? parsed.value : fallback;
}

export function formatMoneyValue(
  raw: string | number | null | undefined,
  fractionDigits = 2,
): string {
  const numeric = safeMoneyValue(raw);
  return numeric.toFixed(fractionDigits);
}
