import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { platformApi, type CompanyWhatsAppOverview } from "../api/platform-client.js";
import { CompanyWhatsAppPanel } from "./CompanyWhatsAppPanel.js";

vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({
    can: (code: string) => code === "platform.company_whatsapp.manage",
  }),
}));

const baseOverview: CompanyWhatsAppOverview = {
  connection: {
    connectedPhoneNumber: "+971500000000",
    lastConnectedAt: "2026-09-01T10:00:00Z",
    lastDisconnectedAt: null,
    status: "connected",
  },
  disabledReason: null,
  enabled: true,
  placeholders: ["orderNumber", "referenceNumber", "status", "date", "companyName"],
  templates: [
    {
      bodyAr: "تحديث: {{orderNumber}}",
      bodyEn: "Update: {{orderNumber}}",
      isCustom: false,
      status: "delivered",
      updatedAt: null,
    },
    {
      bodyAr: "ملغى: {{orderNumber}}",
      bodyEn: "Cancelled: {{orderNumber}}",
      isCustom: true,
      status: "cancelled",
      updatedAt: "2026-09-01T09:00:00Z",
    },
  ],
};

const emptyMessages = {
  items: [],
  page: 1,
  pageSize: 25,
  totals: { failed: 0, pending: 0, sent: 0, total: 0 },
};

describe("CompanyWhatsAppPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows availability, offers Disable with a reason, and confirms the full-off semantics", async () => {
    vi.spyOn(platformApi, "companyWhatsApp").mockResolvedValue(baseOverview);
    vi.spyOn(platformApi, "companyWhatsAppMessages").mockResolvedValue(emptyMessages);
    const disable = vi.spyOn(platformApi, "setCompanyWhatsAppEnabled").mockResolvedValue({
      ...baseOverview,
      disabledReason: "Unpaid invoices",
      enabled: false,
    });

    render(<CompanyWhatsAppPanel companyId="company-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disable WhatsApp" }));
    fireEvent.change(screen.getByLabelText("Reason shown to the company (optional)"), {
      target: { value: "Unpaid invoices" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Disable WhatsApp" }));
    await waitFor(() =>
      expect(disable).toHaveBeenCalledWith("company-a", false, "Unpaid invoices"),
    );
    expect(await screen.findByRole("button", { name: "Enable WhatsApp" })).toBeInTheDocument();
    expect(screen.getByText(/Reason: Unpaid invoices/)).toBeInTheDocument();
  });

  it("edits a template and saves both language bodies", async () => {
    vi.spyOn(platformApi, "companyWhatsApp").mockResolvedValue(baseOverview);
    vi.spyOn(platformApi, "companyWhatsAppMessages").mockResolvedValue(emptyMessages);
    const update = vi
      .spyOn(platformApi, "updateCompanyWhatsAppTemplate")
      .mockResolvedValue(baseOverview);

    render(<CompanyWhatsAppPanel companyId="company-a" />);
    const editButtons = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[0]!);
    fireEvent.change(screen.getByLabelText("English message"), {
      target: { value: "Order {{orderNumber}} was delivered — {{companyName}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("company-a", "delivered", {
        bodyAr: "تحديث: {{orderNumber}}",
        bodyEn: "Order {{orderNumber}} was delivered — {{companyName}}",
      }),
    );
  });

  it("offers Reset to default only for a custom template", async () => {
    vi.spyOn(platformApi, "companyWhatsApp").mockResolvedValue(baseOverview);
    vi.spyOn(platformApi, "companyWhatsAppMessages").mockResolvedValue(emptyMessages);
    const reset = vi
      .spyOn(platformApi, "resetCompanyWhatsAppTemplate")
      .mockResolvedValue(baseOverview);

    render(<CompanyWhatsAppPanel companyId="company-a" />);
    const resetButtons = await screen.findAllByRole("button", { name: "Reset to default" });
    expect(resetButtons).toHaveLength(1);
    fireEvent.click(resetButtons[0]!);
    await waitFor(() => expect(reset).toHaveBeenCalledWith("company-a", "cancelled"));
  });

  it("lists messages with totals and passes the date range to the API", async () => {
    vi.spyOn(platformApi, "companyWhatsApp").mockResolvedValue(baseOverview);
    const list = vi.spyOn(platformApi, "companyWhatsAppMessages").mockResolvedValue({
      items: [
        {
          createdAt: "2026-09-01T12:00:00Z",
          failureCode: null,
          groupNameSnapshot: "Lahza vs NoorStore",
          id: "m1",
          messageBody: "Order Status Update",
          messageLanguage: "both",
          messageType: "order_status",
          orderNumber: "LAH0000021",
          status: "sent",
          traderName: "Lahza",
        },
      ],
      page: 1,
      pageSize: 25,
      totals: { failed: 1, pending: 2, sent: 7, total: 10 },
    });

    render(<CompanyWhatsAppPanel companyId="company-a" />);
    expect(await screen.findByText(/10 messages/)).toBeInTheDocument();
    expect(screen.getByText(/7 sent/)).toBeInTheDocument();
    expect(screen.getByText("LAH0000021")).toBeInTheDocument();
    expect(screen.getByText("Lahza vs NoorStore")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-02" } });
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith("company-a", {
        from: "2026-09-01",
        page: 1,
        pageSize: 25,
        to: "2026-09-02",
      }),
    );
  });
});
