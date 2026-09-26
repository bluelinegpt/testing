import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Sharing a Product.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A BUTTON AND NOT A LINK TO WHATSAPP
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is a row of per-network links. It ages badly: each
 * network needs its own URL format, the formats change, and on a phone they open
 * the web version of an app the shopper already has installed.
 *
 * `navigator.share` hands the URL to the operating system's own sheet instead,
 * which lists whatever the shopper actually has — WhatsApp, Instagram, Messages,
 * AirDrop — with no per-network code here. On a desktop browser without the API
 * the fallback copies the link, which is what a shopper does by hand anyway.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HANDLED
 * ---------------------------------------------------------------------------
 *
 * A cancelled share sheet rejects with `AbortError`. That is the shopper
 * changing their mind, not a failure, and showing an error for it would be
 * wrong. It is swallowed, and only genuine failures fall through to copying.
 *
 * `navigator.share` is checked at click time rather than at render time. It is
 * absent in server-rendered HTML and in tests, and a render-time check would
 * bake "no share support" into the first paint and never re-evaluate it.
 */
export function ShareControl({
  className,
  text,
  title,
}: {
  readonly className?: string | undefined;
  readonly text?: string | undefined;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"copied" | "idle" | "unavailable">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation clears itself, so it must not fire into an unmounted
  // component when the shopper navigates away in the two seconds after copying.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const flash = (next: "copied" | "unavailable") => {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };

  const share = async () => {
    // The address bar, not a reconstructed string: the canonical URL already
    // accounts for the locale prefix, and rebuilding it here would eventually
    // disagree with it.
    const url = window.location.href;

    if (typeof navigator.share === "function") {
      try {
        // Built conditionally rather than passing `text: undefined`: the Web
        // Share API validates the shape it is handed, and an explicitly
        // undefined member is not the same as an absent one.
        await navigator.share(text === undefined ? { title, url } : { text, title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Anything else: fall through and copy instead of dead-ending.
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      flash("copied");
    } catch {
      // Clipboard access can be denied outright. Say so rather than showing a
      // success message for something that did not happen.
      flash("unavailable");
    }
  };

  return (
    <span className="store-share">
      <button
        className={className ?? "store-button store-button--quiet"}
        onClick={() => {
          void share();
        }}
        type="button"
      >
        {t("product.share.action")}
      </button>
      {/* Announced when it changes, so the confirmation is not visual-only. */}
      <span aria-live="polite" className="store-share__status" role="status">
        {state === "idle" ? "" : t(`product.share.${state}`)}
      </span>
    </span>
  );
}
