// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { api, can } = vi.hoisted(() => ({
  api: {
    announcements: vi.fn(),
    cancelAnnouncement: vi.fn(),
    companies: vi.fn(),
    createAnnouncement: vi.fn(),
    endAnnouncementNow: vi.fn(),
    updateAnnouncement: vi.fn(),
  },
  can: vi.fn<(code: string) => boolean>(() => true),
}));

vi.mock("../api/platform-client.js", () => ({ platformApi: api }));
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  can.mockImplementation(() => true);
});

const live = {
  audience: "all_companies",
  bodyAr: "صيانة الليلة",
  bodyEn: "Maintenance tonight 05:00-06:00",
  companies: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  createdBy: "aiman",
  displayStatus: "live",
  id: "11111111-1111-4111-8111-111111111111",
  showFrom: "2026-10-12T00:00:00.000Z",
  showUntil: "2026-10-14T02:00:00.000Z",
  status: "active",
  surfaces: ["office_web", "trader_portal"],
  titleAr: "صيانة",
  titleEn: "Upcoming maintenance",
  type: "warning",
  updatedAt: "2026-10-10T00:00:00.000Z",
  updatedBy: "aiman",
  version: 1,
};

async function renderPage() {
  const { AnnouncementsPage } = await import("./AnnouncementsPage.js");
  render(
    <MemoryRouter>
      <AnnouncementsPage />
    </MemoryRouter>,
  );
}

describe("UAE time conversion", () => {
  it("reads and writes Show from / until in UAE time", async () => {
    const { fromDubaiInput, toDubaiInput } = await import("./AnnouncementsPage.js");
    expect(fromDubaiInput("2026-10-14T05:00")).toBe("2026-10-14T01:00:00.000Z");
    expect(toDubaiInput(new Date("2026-10-14T01:00:00.000Z"))).toBe("2026-10-14T05:00");
    expect(fromDubaiInput("")).toBeNull();
  });
});

describe("Announcements page", () => {
  it("lists announcements with where, who, UAE times and status", async () => {
    api.announcements.mockResolvedValueOnce([live]);
    await renderPage();
    const row = (await screen.findByText("Upcoming maintenance")).closest("tr")!;
    expect(within(row).getByText("Warning")).toBeInTheDocument();
    expect(within(row).getByText("Office web, Trader portal")).toBeInTheDocument();
    expect(within(row).getByText("All Companies")).toBeInTheDocument();
    expect(within(row).getByText(/12 Oct 2026, 04:00 – 14 Oct 2026, 06:00/)).toBeInTheDocument();
    expect(within(row).getByText("Live")).toBeInTheDocument();
  });

  it("creates a bilingual announcement for chosen Companies, sending UTC times", async () => {
    api.announcements.mockResolvedValue([]);
    api.companies.mockResolvedValue({
      items: [{ code: "LAH", id: "4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb", nameEn: "Lahthza" }],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    api.createAnnouncement.mockResolvedValue({ ...live, displayStatus: "scheduled" });
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New announcement" }));
    const form = screen.getByRole("form", { name: "New announcement" });
    fireEvent.change(within(form).getByLabelText("English title"), {
      target: { value: "Upcoming maintenance" },
    });
    fireEvent.change(within(form).getByLabelText("English message"), {
      target: { value: "We will upgrade the system on 14 October, 05:00-06:00." },
    });
    fireEvent.change(within(form).getByLabelText(/Arabic title/), { target: { value: "صيانة" } });
    fireEvent.change(within(form).getByLabelText(/Arabic message/), {
      target: { value: "سنقوم بتحديث النظام" },
    });
    fireEvent.change(within(form).getByLabelText("Show from (UAE time)"), {
      target: { value: "2030-10-12T04:00" },
    });
    fireEvent.change(within(form).getByLabelText("Show until (UAE time)"), {
      target: { value: "2030-10-14T06:00" },
    });
    fireEvent.click(within(form).getByLabelText("Trader portal"));
    fireEvent.click(within(form).getByLabelText("Selected Companies"));
    fireEvent.click(await within(form).findByRole("button", { name: "Add Lahthza" }));
    // The preview shows both languages.
    const preview = within(form).getByRole("region", { name: "Preview" });
    expect(within(preview).getByText("Upcoming maintenance")).toBeInTheDocument();
    expect(within(preview).getByText("صيانة")).toBeInTheDocument();

    fireEvent.click(within(form).getByRole("button", { name: "Create announcement" }));
    await waitFor(() => expect(api.createAnnouncement).toHaveBeenCalledTimes(1));
    expect(api.createAnnouncement).toHaveBeenCalledWith({
      audience: "selected_companies",
      bodyAr: "سنقوم بتحديث النظام",
      bodyEn: "We will upgrade the system on 14 October, 05:00-06:00.",
      companyIds: ["4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb"],
      showFrom: "2030-10-12T00:00:00.000Z",
      showUntil: "2030-10-14T02:00:00.000Z",
      surfaces: ["office_web", "trader_portal"],
      titleAr: "صيانة",
      titleEn: "Upcoming maintenance",
      type: "warning",
    });
    expect(await screen.findByText(/Saved. It will show from/)).toBeInTheDocument();
  });

  it("explains problems instead of saving", async () => {
    api.announcements.mockResolvedValue([]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New announcement" }));
    const form = screen.getByRole("form", { name: "New announcement" });
    fireEvent.change(within(form).getByLabelText("English title"), { target: { value: "Only a title" } });
    fireEvent.change(within(form).getByLabelText("Show until (UAE time)"), {
      target: { value: "2020-01-01T00:00" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create announcement" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("The English text needs both a title and a message.");
    expect(alert).toHaveTextContent("Show until must be after Show from.");
    expect(api.createAnnouncement).not.toHaveBeenCalled();
  });

  it("asks before ending an announcement now", async () => {
    api.announcements.mockResolvedValue([live]);
    api.endAnnouncementNow.mockResolvedValue({ ...live, displayStatus: "ended" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "End Upcoming maintenance now" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.endAnnouncementNow).toHaveBeenCalledWith(live.id));
    expect(await screen.findByText("Announcement ended.")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("is read-only without the manage permission", async () => {
    can.mockImplementation((code: string) => code !== "platform.announcements.manage");
    api.announcements.mockResolvedValue([live]);
    await renderPage();
    await screen.findByText("Upcoming maintenance");
    expect(screen.queryByRole("button", { name: "New announcement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
  });
});
