import type { AnalyticsEventName } from "./analytics";

/**
 * Meta (Facebook / Instagram) Pixel for tawseelhub.com -- added 16 Nov 2026
 * for the Tawseelhub ad campaigns (Aiman). Dataset "Tawseelhub Website".
 *
 * It follows the SAME rules as Google Tag Manager / GA4 in tracking.ts: it is
 * installed only on the environment Platform Administration's tracking
 * settings allow, only when analytics is switched on there, and events are
 * sent only while the visitor has not declined analytics. Test and local
 * visits therefore never reach the ad data.
 *
 * Events are not caught from the page: the website's own named analytics
 * events are translated to Meta's standard events, so every WhatsApp button
 * (floating icon, Contact page, blog, chat hand-off) counts the same way.
 */
export const META_PIXEL_ID = "1900268184478480";

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  loaded?: boolean;
  push?: unknown;
  queue: unknown[];
  version?: string;
};

declare global {
  interface Window {
    _fbq?: Fbq;
    fbq?: Fbq;
  }
}

/** Website event -> Meta standard event. Unlisted events are not sent to Meta. */
export const metaStandardEvents: Partial<Record<AnalyticsEventName, string>> = {
  agent_demo_request_success: "Lead",
  agent_trader_application_success: "CompleteRegistration",
  agent_whatsapp_handoff_started: "Contact",
  contact_form_submitted: "Contact",
  // Sent once per demo reference (trackConversionOnce), so a refresh does not
  // count a second lead. `demo_form_success` fires for the same submission and
  // is deliberately NOT mapped, to avoid counting it twice.
  demo_request_submitted: "Lead",
  trader_application_success: "CompleteRegistration",
  whatsapp_contact_started: "Contact",
};

let installed = false;

/** Loads the Pixel once and records the landing page view. */
export function installMetaPixel(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  if (!window.fbq) {
    // Meta's standard loader, written out: queue calls until fbevents.js loads.
    const fbq = ((...args: unknown[]) => {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    }) as Fbq;
    fbq.queue = [];
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    window.fbq = fbq;
    window._fbq = window._fbq ?? fbq;
    const script = document.createElement("script");
    script.async = true;
    script.id = "tawseelhub-meta-pixel";
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    // A blocked or failed fbevents.js only means no Meta data; the queued
    // calls are simply never sent.
    document.head.append(script);
  }
  window.fbq?.("init", META_PIXEL_ID);
  window.fbq?.("track", "PageView");
}

/** A page change inside the single-page app (the first view is sent by install). */
export function trackMetaPageView(): void {
  if (!installed) return;
  try {
    window.fbq?.("track", "PageView");
  } catch {
    // Third-party tracking must never affect the public user journey.
  }
}

/** Forwards a website analytics event that has a Meta standard equivalent. */
export function forwardToMetaPixel(name: AnalyticsEventName): void {
  const standard = metaStandardEvents[name];
  if (!installed || standard === undefined) return;
  try {
    window.fbq?.("track", standard);
  } catch {
    // Third-party tracking must never affect the public user journey.
  }
}

/** Test-only: forget the installed state between tests. */
export function resetMetaPixelForTests(): void {
  installed = false;
}
