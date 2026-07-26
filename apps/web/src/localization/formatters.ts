import type { SupportedLocale } from "./locale.js";

const localeTags: Record<SupportedLocale, string> = {
  ar: "ar-AE",
  en: "en-AE",
};

const decimalPattern = /^(?<sign>-?)(?<integer>0|[1-9]\d*)(?:\.(?<fraction>\d{1,2}))?$/;

export function formatDate(
  value: Date | string,
  locale: SupportedLocale,
  timeZone = "Asia/Dubai",
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date value");

  return new Intl.DateTimeFormat(localeTags[locale], {
    day: "2-digit",
    month: "short",
    timeZone,
    year: "numeric",
  }).format(date);
}

export function formatDateTime(
  value: Date | string,
  locale: SupportedLocale,
  timeZone = "Asia/Dubai",
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date value");
  return new Intl.DateTimeFormat(localeTags[locale], {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone,
    year: "numeric",
  }).format(date);
}

export function formatNumber(value: number | bigint, locale: SupportedLocale): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("Number must be finite");
  }

  return new Intl.NumberFormat(localeTags[locale]).format(value);
}

export function formatCurrency(
  decimalValue: string,
  currencyCode: string,
  locale: SupportedLocale,
): string {
  const match = decimalPattern.exec(decimalValue);
  if (match?.groups === undefined) {
    throw new RangeError("Currency value must be a decimal string with at most two decimal places");
  }

  const currency = currencyCode.trim().toUpperCase();
  const integerValue = BigInt(`${match.groups.sign}${match.groups.integer}`);
  const fraction = (match.groups.fraction ?? "").padEnd(2, "0");
  const formatter = new Intl.NumberFormat(localeTags[locale], {
    currency,
    currencyDisplay: "code",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  });
  const groupedInteger = new Intl.NumberFormat(localeTags[locale], {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(integerValue);
  const localizedFraction = localizeDigits(fraction, locale);

  let insertedInteger = false;
  return formatter
    .formatToParts(integerValue < 0n ? -0 : 0)
    .map((part) => {
      if (part.type === "minusSign") return integerValue < 0n ? part.value : "";
      if (part.type === "integer") {
        if (insertedInteger) return "";
        insertedInteger = true;
        return groupedInteger.replace(/^[-−]/u, "");
      }
      if (part.type === "fraction") return localizedFraction;
      return part.value;
    })
    .join("");
}

function localizeDigits(value: string, locale: SupportedLocale): string {
  const formatter = new Intl.NumberFormat(localeTags[locale], { useGrouping: false });
  return [...value].map((digit) => formatter.format(BigInt(digit))).join("");
}
