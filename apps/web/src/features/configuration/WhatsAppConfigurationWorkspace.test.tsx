import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { WhatsAppConfigurationWorkspace, shortGroupId } from "./WhatsAppConfigurationWorkspace.js";

const MANAGE = ["whatsapp.connection.manage"] as const;

function connectionView(overrides: Record<string, unknown> = {}) {
  return {
    connectedAt: null,
    connectedPhoneNumber: null,
    disconnectReason: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastHealthCheckAt: null,
    providerType: "unconfigured",
    qr: null,
    qrAvailable: false,
    requiresQrScan: false,
    status: "not_connected",
    ...overrides,
  };
}

function makeApi(handlers: {
  connection?: () => unknown;
  groups?: () => unknown;
  summary?: () => unknown;
  messages?: () => unknown;
  messageDetail?: () => unknown;
  groupHealth?: () => unknown;
}) {
  const get = vi.fn((path: string) => {
    if (path === "whatsapp/connection") {
      return Promise.resolve(handlers.connection?.() ?? connectionView());
    }
    if (path === "whatsapp/groups") {
      return Promise.resolve(handlers.groups?.() ?? []);
    }
    if (path === "whatsapp/messages/summary") {
      return Promise.resolve(
        handlers.summary?.() ?? {
          failed: 0,
          lastSuccessfulSendAt: null,
          oldestPendingAt: null,
          pending: 0,
          processing: 0,
          requiresReview: 0,
          sentLast24h: 0,
          sentToday: 0,
        },
      );
    }
    if (path.startsWith("whatsapp/messages?")) {
      return Promise.resolve(
        handlers.messages?.() ?? { items: [], page: 1, pageSize: 25, total: 0 },
      );
    }
    if (path.startsWith("whatsapp/messages/")) {
      return Promise.resolve(handlers.messageDetail?.() ?? {});
    }
    if (path === "whatsapp/dispatcher/health") {
      return Promise.resolve({ lastSendAt: null, lastTickAt: null, running: true });
    }
    if (path === "whatsapp/trader-groups/health") {
      return Promise.resolve(
        handlers.groupHealth?.() ?? {
          availableCount: 0,
          checkedAt: null,
          configured: 0,
          connected: true,
          needsAttention: 0,
          rows: [],
        },
      );
    }
    return Promise.reject(new Error(`unexpected get ${path}`));
  });
  const post = vi.fn((path: string) => {
    if (path.startsWith("whatsapp/connection/")) {
      return Promise.resolve(handlers.connection?.() ?? connectionView());
    }
    return Promise.reject(new Error(`unexpected post ${path}`));
  });
  return { api: { get, post } as unknown as ApiClient, get, post };
}

describe("WhatsAppConfigurationWorkspace", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows the disconnected state and starts a connection", async () => {
    const { api, post } = makeApi({});
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("Not Connected");
    expect(
      screen.getByText("Connect your Delivery Company WhatsApp account to Tawseelhub."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Connect WhatsApp/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("whatsapp/connection/connect"));
  });

  it("hides every connection control from users without the manage permission", async () => {
    const { api } = makeApi({});
    render(<WhatsAppConfigurationWorkspace api={api} permissions={["whatsapp.history.view"]} />);
    await screen.findByText("Not Connected");
    expect(screen.queryByRole("button", { name: /Connect WhatsApp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).not.toBeInTheDocument();
  });

  it("renders QR pairing instructions from polled state without persisting the QR", async () => {
    const { api } = makeApi({
      connection: () =>
        connectionView({
          qr: "RAW-QR-PAIRING-PAYLOAD",
          qrAvailable: true,
          requiresQrScan: true,
          status: "waiting_for_qr_scan",
        }),
    });
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("Scan this QR code with WhatsApp");
    expect(
      screen.getByText("WhatsApp → Settings → Linked Devices → Link a Device"),
    ).toBeInTheDocument();
    // The transient QR payload must never touch browser storage.
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
  });

  it("polls while connecting and stops once connected", async () => {
    vi.useFakeTimers();
    try {
      let status = "connecting";
      const { api, get } = makeApi({ connection: () => connectionView({ status }) });
      render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
      await act(async () => {
        await Promise.resolve();
      });
      const connectionCalls = () =>
        get.mock.calls.filter(([path]) => path === "whatsapp/connection").length;
      expect(connectionCalls()).toBe(1);

      status = "connected";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(connectionCalls()).toBe(2);

      // Settled: the interval is gone; further time adds no polls.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(connectionCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the connected account, discovers groups, searches, and keeps duplicates distinct", async () => {
    const groups = [
      { id: "111111@g.us", name: "Dana vs NoorStore", participantCount: 4 },
      { id: "222222@g.us", name: "Dana vs NoorStore", participantCount: 2 },
      { id: "333333@g.us", name: "Noor Dispatch", participantCount: 7 },
    ];
    const { api, get } = makeApi({
      connection: () =>
        connectionView({
          connectedAt: "2026-08-31T18:00:00Z",
          connectedPhoneNumber: "+971501234567",
          lastConnectedAt: "2026-08-31T18:00:00Z",
          lastHealthCheckAt: "2026-08-31T18:05:00Z",
          providerType: "baileys",
          status: "connected",
        }),
      groups: () => groups,
    });
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("+971501234567");
    await screen.findByText("Noor Dispatch");
    // Duplicate display names carry an abbreviated provider id suffix each.
    expect(screen.getByText(shortGroupId("111111@g.us"))).toBeInTheDocument();
    expect(screen.getByText(shortGroupId("222222@g.us"))).toBeInTheDocument();
    // No raw participant identities anywhere.
    expect(document.body.textContent).not.toContain("s.whatsapp.net");

    fireEvent.change(screen.getByPlaceholderText("Search groups..."), {
      target: { value: "Dispatch" },
    });
    expect(screen.queryAllByText("Dana vs NoorStore")).toHaveLength(0);
    expect(screen.getByText("Noor Dispatch")).toBeInTheDocument();

    const groupCalls = () => get.mock.calls.filter(([path]) => path === "whatsapp/groups").length;
    const before = groupCalls();
    fireEvent.click(screen.getByRole("button", { name: /Refresh Groups/ }));
    await waitFor(() => expect(groupCalls()).toBe(before + 1));
  });

  it("requires confirmation before disconnecting", async () => {
    const { api, post } = makeApi({
      connection: () =>
        connectionView({
          connectedPhoneNumber: "+971501234567",
          lastConnectedAt: "2026-08-31T18:00:00Z",
          status: "connected",
        }),
    });
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("+971501234567");
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/ }));
    await screen.findByText(/Trader WhatsApp group mappings will remain saved/);
    expect(post).not.toHaveBeenCalled();
    const confirmButtons = screen.getAllByRole("button", { name: "Disconnect" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith("whatsapp/connection/disconnect"));
  });

  it("offers a prominent reconnect for reconnect-required states", async () => {
    const { api, post } = makeApi({
      connection: () => connectionView({ status: "requires_reconnect" }),
    });
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("WhatsApp needs to be reconnected.");
    fireEvent.click(screen.getByRole("button", { name: /Reconnect WhatsApp/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("whatsapp/connection/reconnect"));
  });

  it("shows the message-delivery pipeline counts", async () => {
    const { api } = makeApi({
      summary: () => ({
        failed: 2,
        lastSuccessfulSendAt: "2026-09-01T07:00:00Z",
        oldestPendingAt: null,
        pending: 3,
        processing: 0,
        requiresReview: 1,
        sentLast24h: 9,
        sentToday: 7,
      }),
    });
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    const heading = await screen.findByText("Message Delivery");
    const panel = within(heading.closest("section") as HTMLElement);
    expect(panel.getByText("Pending").nextElementSibling?.textContent).toBe("3");
    expect(panel.getByText("Failed").nextElementSibling?.textContent).toBe("2");
    expect(panel.getByText("Requires Review").nextElementSibling?.textContent).toBe("1");
    expect(panel.getByText("Sent Today").nextElementSibling?.textContent).toBe("7");
    expect(panel.getByText("Sent Last 24 Hours").nextElementSibling?.textContent).toBe("9");
  });

  it("lists message operations with a safe failure category and filters by status", async () => {
    const { api, get } = makeApi({
      messages: () => ({
        items: [
          {
            attemptCount: 2,
            createdAt: "2026-09-01T08:40:00Z",
            failureCode: "provider_timeout",
            groupNameSnapshot: "Dana vs NoorStore",
            id: "11111111-1111-4111-8111-111111111111",
            messageLanguage: "both",
            messageType: "order_status",
            nextAttemptAt: null,
            orderNumber: "DAN-000123",
            orderStatus: "out_for_delivery",
            sentAt: null,
            status: "requires_review",
            traderName: "Noor Store",
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      }),
    });
    render(
      <WhatsAppConfigurationWorkspace
        api={api}
        permissions={["whatsapp.connection.manage", "whatsapp.messages.manage"]}
      />,
    );
    await screen.findByText("DAN-000123");
    expect(screen.getByText("Noor Store")).toBeInTheDocument();
    // The uncertain state is explained honestly, never as "not delivered".
    expect(
      screen.getByText(/could not confirm whether WhatsApp accepted this message/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("All statuses"), {
      target: { value: "failed" },
    });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(expect.stringContaining("status=failed")),
    );
  });

  it("guards Retry Anyway behind the duplicate-risk warning and posts the confirmation", async () => {
    const detail = {
      attemptCount: 1,
      attempts: [
        {
          attemptNumber: 1,
          completedAt: "2026-09-01T08:41:00Z",
          failureClassification: "unknown",
          providerResponseSummary: "outcome_uncertain",
          result: "failed",
          startedAt: "2026-09-01T08:40:00Z",
        },
      ],
      createdAt: "2026-09-01T08:40:00Z",
      failureCode: "provider_timeout",
      failureReason: "provider_outcome_uncertain",
      groupNameSnapshot: "Dana vs NoorStore",
      id: "11111111-1111-4111-8111-111111111111",
      messageBody: "body",
      messageLanguage: "both",
      messageType: "test",
      nextAttemptAt: null,
      orderNumber: null,
      orderStatus: null,
      providerGroupId: "120363000000000001@g.us",
      providerMessageId: null,
      queuedAt: "2026-09-01T08:40:00Z",
      sentAt: null,
      status: "requires_review",
      traderName: "Noor Store",
    };
    const { api, post } = makeApi({
      messageDetail: () => detail,
      messages: () => ({ items: [detail], page: 1, pageSize: 25, total: 1 }),
    });
    render(
      <WhatsAppConfigurationWorkspace
        api={api}
        permissions={["whatsapp.connection.manage", "whatsapp.messages.manage"]}
      />,
    );
    await screen.findByText("Dana vs NoorStore");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("Message Details");
    fireEvent.click(screen.getByRole("button", { name: "Retry Anyway" }));
    await screen.findByText("Retry this WhatsApp message?");
    expect(post).not.toHaveBeenCalled();
    const confirmButtons = screen.getAllByRole("button", { name: "Retry Anyway" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "whatsapp/messages/11111111-1111-4111-8111-111111111111/retry",
        { confirmDuplicateRisk: true },
      ),
    );
  });

  it("surfaces Trader group mappings that discovery no longer returns", async () => {
    const { api } = makeApi({
      connection: () =>
        connectionView({
          connectedPhoneNumber: "+971501234567",
          lastConnectedAt: "2026-08-31T18:00:00Z",
          status: "connected",
        }),
      groupHealth: () => ({
        availableCount: 1,
        checkedAt: "2026-09-01T09:00:00Z",
        configured: 2,
        connected: true,
        needsAttention: 1,
        rows: [
          {
            available: true,
            groupNameSnapshot: "Healthy Group",
            providerGroupId: "111@g.us",
            traderId: "t1",
            traderName: "Healthy Trader",
          },
          {
            available: false,
            groupNameSnapshot: "Missing Group",
            providerGroupId: "222@g.us",
            traderId: "t2",
            traderName: "Broken Trader",
          },
        ],
      }),
    });
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("Trader Group Configuration Health");
    expect(screen.getByText(/2 configured/)).toBeInTheDocument();
    expect(screen.getByText(/1 need attention/)).toBeInTheDocument();
    expect(screen.getByText("Broken Trader")).toBeInTheDocument();
    expect(screen.queryByText("Healthy Trader")).not.toBeInTheDocument();
  });

  it("renders in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    const { api } = makeApi({});
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("غير متصل");
    expect(screen.getByRole("button", { name: /ربط واتساب/ })).toBeInTheDocument();
  });
});
