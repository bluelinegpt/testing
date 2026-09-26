import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Loading, empty and error states.
 *
 * One component each, used everywhere, so the three of them look like one
 * application rather than three developers' opinions.
 *
 * `MessageState` takes a translation key, never an API error. A customer has
 * nothing to do with an error code, and an error body is one of the easiest
 * ways for internal identifiers to escape a system that was careful everywhere
 * else.
 *
 * The skeleton renders the SAME grid and the same number of tiles the real
 * content will occupy, so the page does not jump when data lands.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EMPTY STATE IS A COMPOSED CARD
 * ---------------------------------------------------------------------------
 *
 * A Subcategory with no Products previously produced a heading floating in a
 * large blank area, which reads as a page that failed rather than a category
 * that is genuinely empty. It is now a bounded panel with an icon, an
 * explanation and — where the caller has somewhere sensible to send the
 * shopper — a way out. Both strings are localized; neither invents data.
 */

export function LoadingGrid({ tiles = 4 }: { readonly tiles?: number }) {
  return (
    <div aria-busy="true" className="store-grid store-grid--products">
      {Array.from({ length: tiles }, (_, index) => (
        <div className="store-skeleton" key={index} />
      ))}
    </div>
  );
}

export function MessageState({
  action,
  bodyKey,
  onRetry,
  titleKey,
  tone = "empty",
}: {
  /** A way out of the dead end — a link the caller knows actually resolves. */
  readonly action?: ReactNode;
  readonly bodyKey: string;
  readonly onRetry?: () => void;
  readonly titleKey: string;
  readonly tone?: "empty" | "error";
}) {
  const { t } = useTranslation();
  return (
    <div className={`store-state store-state--${tone}`} role="status">
      <span aria-hidden="true" className="store-state__icon">
        {tone === "error" ? <AlertIcon /> : <EmptyIcon />}
      </span>
      <h2 className="store-state__title">{t(titleKey)}</h2>
      <p className="store-state__body">{t(bodyKey)}</p>
      {onRetry === undefined ? null : (
        <button className="store-button" onClick={onRetry} type="button">
          {t("common.retry")}
        </button>
      )}
      {action === undefined ? null : <div className="store-state__action">{action}</div>}
    </div>
  );
}

function EmptyIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 32 32">
      <rect height="18" rx="3" stroke="currentColor" strokeWidth="1.8" width="22" x="5" y="7" />
      <path d="M5 14h22" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 20h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 10v8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <circle cx="16" cy="22" fill="currentColor" r="1.2" />
    </svg>
  );
}
