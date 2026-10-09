import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../api/api-client.js";
import { i18nInstance } from "../localization/i18n.js";
import {
  type ActiveAnnouncement,
  AnnouncementBanner,
  announcementText,
  clearDismissedAnnouncements,
} from "./AnnouncementBanner.js";

const maintenance: ActiveAnnouncement = {
  bodyAr: "سنقوم بتحديث النظام يوم 14 أكتوبر من 5:00 إلى 6:00 صباحاً.",
  bodyEn: "We will upgrade the system on 14 October, 05:00-06:00 (UAE).",
  id: "11111111-1111-4111-8111-111111111111",
  titleAr: "صيانة مجدولة",
  titleEn: "Upcoming maintenance",
  type: "warning",
  version: 1,
};

function setup(result: unknown, surface: "office_web" | "trader_portal" = "office_web") {
  const api = {
    get: vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  };
  const view = render(<AnnouncementBanner api={api as unknown as ApiClient} surface={surface} />);
  return { api, view };
}

beforeEach(async () => {
  clearDismissedAnnouncements();
  await i18nInstance.changeLanguage("en");
});

describe("AnnouncementBanner", () => {
  it("asks for its own screen and shows the English text", async () => {
    const { api } = setup([maintenance], "trader_portal");
    expect(await screen.findByText("Upcoming maintenance")).toBeInTheDocument();
    expect(screen.getByText(/05:00-06:00/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("announcements/active?surface=trader_portal");
    expect(screen.getByRole("status")).toHaveClass("announcement-banner--warning");
  });

  it("shows Arabic right-to-left when the screen is in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    setup([maintenance]);
    const title = await screen.findByText("صيانة مجدولة");
    expect(title.closest(".announcement-banner")).toHaveAttribute("dir", "rtl");
  });

  it("falls back to the other language when one is missing", () => {
    const englishOnly = { ...maintenance, bodyAr: null, titleAr: null };
    expect(announcementText(englishOnly, "ar").title).toBe("Upcoming maintenance");
    const arabicOnly = { ...maintenance, bodyEn: null, titleEn: null };
    expect(announcementText(arabicOnly, "en").title).toBe("صيانة مجدولة");
  });

  it("uses an alert for a critical announcement", async () => {
    setup([{ ...maintenance, type: "critical" }]);
    expect(await screen.findByRole("alert")).toHaveClass("announcement-banner--critical");
  });

  it("stays closed for the session, and shows again when the Platform edits it", async () => {
    const first = setup([maintenance]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close announcement: Upcoming maintenance" }),
    );
    await waitFor(() => expect(screen.queryByText("Upcoming maintenance")).toBeNull());
    first.view.unmount();

    // Same version, same session: still closed.
    const again = setup([maintenance]);
    await waitFor(() => expect(again.api.get).toHaveBeenCalled());
    expect(screen.queryByText("Upcoming maintenance")).toBeNull();
    again.view.unmount();

    // Edited on the Platform: shown again.
    setup([{ ...maintenance, version: 2 }]);
    expect(await screen.findByText("Upcoming maintenance")).toBeInTheDocument();
  });

  it("shows again after sign-out clears the closed list", async () => {
    const first = setup([maintenance]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close announcement: Upcoming maintenance" }),
    );
    first.view.unmount();
    clearDismissedAnnouncements();
    setup([maintenance]);
    expect(await screen.findByText("Upcoming maintenance")).toBeInTheDocument();
  });

  it("renders nothing when the request fails", async () => {
    const { api, view } = setup(new Error("offline"));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(view.container).toBeEmptyDOMElement();
  });
});
