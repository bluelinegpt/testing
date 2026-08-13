import { act, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import { storeI18n } from "../localization/i18n.js";

import { OfflineBanner } from "./OfflineBanner.js";
import { NetworkStatusProvider } from "./network-status.js";

/**
 * §74: offline banner appears only on a genuine browser offline event, and
 * clears on reconnect -- never for an ordinary API error (this component
 * has no dependency on fetch results at all, only on `window`'s own
 * online/offline events, which is what this test exercises directly).
 */
describe("Network status / offline banner", () => {
  function renderBanner() {
    render(
      <I18nextProvider i18n={storeI18n}>
        <NetworkStatusProvider>
          <OfflineBanner />
        </NetworkStatusProvider>
      </I18nextProvider>,
    );
  }

  afterEach(() => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  });

  it("renders nothing when the browser reports online", () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    renderBanner();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the offline banner when the browser fires an offline event", () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    renderBanner();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "You're offline. Some Store features may be unavailable.",
    );
  });

  it("clears the banner again once the browser reports reconnection", () => {
    renderBanner();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
