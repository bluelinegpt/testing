// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  setAnalyticsConsent,
  setAnalyticsTrackingEnabled,
  trackConversionOnce,
  trackEvent,
} from "./analytics";
import {
  installMetaPixel,
  META_PIXEL_ID,
  resetMetaPixelForTests,
  trackMetaPageView,
} from "./meta-pixel";

const calls = () => (window.fbq?.queue ?? []).map((args) => Array.from(args as unknown[]));

describe("Meta Pixel (16 Nov 2026)", () => {
  beforeEach(() => {
    resetMetaPixelForTests();
    delete window.fbq;
    delete window._fbq;
    document.head.innerHTML = "";
    window.localStorage.clear();
    window.sessionStorage.clear();
    setAnalyticsTrackingEnabled(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("serves the domain verification tag in the HTML itself, where Meta looks for it", () => {
    const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
    expect(html).toContain(
      '<meta name="facebook-domain-verification" content="fmnq8qymy5r1bfekl9qezjwsm4i78c" />',
    );
  });

  it("loads the Pixel once and records the landing page view", () => {
    installMetaPixel();
    installMetaPixel();
    expect(document.querySelectorAll("#tawseelhub-meta-pixel")).toHaveLength(1);
    expect(calls()).toEqual([
      ["init", META_PIXEL_ID],
      ["track", "PageView"],
    ]);
  });

  it("sends a PageView for page changes inside the app", () => {
    installMetaPixel();
    trackMetaPageView();
    expect(calls().filter(([, event]) => event === "PageView")).toHaveLength(2);
  });

  it("translates WhatsApp clicks, demo requests and trader registrations to Meta standard events", () => {
    installMetaPixel();
    trackEvent("whatsapp_contact_started", { page: "/contact" });
    trackEvent("agent_whatsapp_handoff_started");
    trackConversionOnce("demo_request_submitted", "DEMO-000123");
    trackConversionOnce("demo_request_submitted", "DEMO-000123");
    trackEvent("demo_form_success");
    trackEvent("trader_application_success");
    trackEvent("pricing_viewed");
    expect(calls().slice(2)).toEqual([
      ["track", "Contact"],
      ["track", "Contact"],
      ["track", "Lead"],
      ["track", "CompleteRegistration"],
    ]);
  });

  it("sends nothing when the visitor declined analytics or tracking is off", () => {
    installMetaPixel();
    setAnalyticsConsent("denied");
    trackEvent("whatsapp_contact_started");
    setAnalyticsConsent("granted");
    setAnalyticsTrackingEnabled(false);
    trackEvent("whatsapp_contact_started");
    expect(calls().slice(2)).toEqual([]);
  });

  it("sends nothing before the Pixel is installed (test or local environments)", () => {
    trackEvent("whatsapp_contact_started");
    trackMetaPageView();
    expect(window.fbq).toBeUndefined();
  });
});
