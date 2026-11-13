import { useTranslation } from "react-i18next";

import { normalizeLocale, type SupportedLocale } from "../localization/locale.js";

const todayPrefix: Record<SupportedLocale, string> = {
  ar: "اليوم",
  en: "Today",
};

/** "Fri, 13 Nov 2026" (English) / the Arabic equivalent, in Asia/Dubai time. */
export function formatTodayDate(now: Date, locale: SupportedLocale): string {
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Dubai",
    weekday: "short",
    year: "numeric",
  };
  if (locale === "ar") return new Intl.DateTimeFormat("ar-AE", options).format(now);
  const parts = new Intl.DateTimeFormat("en-AE", options).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`;
}

export function TodayDateLabel({ className = "" }: { className?: string }) {
  const { i18n } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  return (
    <span
      className={`today-date-label ${className}`.trim()}
      style={{ color: "var(--muted, #667085)", fontSize: "0.8125rem", whiteSpace: "nowrap" }}
    >
      {todayPrefix[locale]}: {formatTodayDate(new Date(), locale)}
    </span>
  );
}
