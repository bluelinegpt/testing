import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertOctagon, AlertTriangle, Info, X } from "lucide-react";

import type { ApiClient } from "../api/api-client.js";

/**
 * Platform announcements: the banner at the top of the Company screens, for
 * example "Upcoming maintenance on 14 October, 05:00-06:00".
 *
 * The Platform decides who sees what and when; this component only asks the
 * API what is live for the signed-in account on this screen. It never blocks
 * the app: if the request fails, nothing is shown.
 *
 * Closing a banner hides it for the rest of the session. The closed list is
 * kept in sessionStorage under the announcement's id AND version, and cleared
 * at sign-out, so the banner comes back at the next sign-in, and comes back
 * at once if the Platform edits it.
 */

export type AnnouncementSurface = "office_web" | "trader_portal" | "mobile_app";

export interface ActiveAnnouncement {
  readonly id: string;
  readonly version: number;
  readonly type: "info" | "warning" | "critical";
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly bodyEn: string | null;
  readonly bodyAr: string | null;
}

const DISMISSED_KEY = "blueline.announcements.dismissed.v1";
const REFRESH_MS = 10 * 60 * 1000;

function readDismissed(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(keys: ReadonlySet<string>): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Closing still works for this page view without storage.
  }
}

/** Called at sign-out, so closed banners show again at the next sign-in. */
export function clearDismissedAnnouncements(): void {
  try {
    window.sessionStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing to clear.
  }
}

const dismissKey = (announcement: ActiveAnnouncement) =>
  `${announcement.id}:${announcement.version}`;

/** The text in the reader's language, falling back to the other one. */
export function announcementText(
  announcement: ActiveAnnouncement,
  language: string,
): { title: string; body: string; language: "en" | "ar" } {
  const arabicFirst = language.startsWith("ar");
  const arabic =
    announcement.titleAr !== null && announcement.bodyAr !== null
      ? { body: announcement.bodyAr, language: "ar" as const, title: announcement.titleAr }
      : null;
  const english =
    announcement.titleEn !== null && announcement.bodyEn !== null
      ? { body: announcement.bodyEn, language: "en" as const, title: announcement.titleEn }
      : null;
  return (arabicFirst ? (arabic ?? english) : (english ?? arabic)) ?? {
    body: "",
    language: "en",
    title: "",
  };
}

const icons = {
  critical: AlertOctagon,
  info: Info,
  warning: AlertTriangle,
} as const;

export function AnnouncementBanner({
  api,
  surface,
}: {
  api: ApiClient;
  surface: AnnouncementSurface;
}) {
  const { i18n, t } = useTranslation();
  const [items, setItems] = useState<readonly ActiveAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());

  const load = useCallback(async () => {
    try {
      const result = await api.get<readonly ActiveAnnouncement[]>(
        `announcements/active?surface=${surface}`,
      );
      setItems(Array.isArray(result) ? result : []);
    } catch {
      // Never let a banner request disturb the app.
      setItems([]);
    }
  }, [api, surface]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = items.filter((item) => !dismissed.has(dismissKey(item)));
  if (visible.length === 0) return null;

  const close = (item: ActiveAnnouncement) => {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(dismissKey(item));
      writeDismissed(next);
      return next;
    });
  };

  return (
    <section aria-label={t("announcements.region")} className="announcement-banners">
      {visible.map((item) => {
        const text = announcementText(item, i18n.resolvedLanguage ?? "en");
        const Icon = icons[item.type] ?? Info;
        return (
          <div
            className={`announcement-banner announcement-banner--${item.type}`}
            dir={text.language === "ar" ? "rtl" : "ltr"}
            key={dismissKey(item)}
            lang={text.language}
            role={item.type === "critical" ? "alert" : "status"}
          >
            <Icon aria-hidden="true" className="announcement-banner__icon" size={18} />
            <p className="announcement-banner__text">
              <strong>{text.title}</strong> <span>{text.body}</span>
            </p>
            <button
              aria-label={t("announcements.close", { title: text.title })}
              className="announcement-banner__close"
              onClick={() => close(item)}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
