import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function makeApi(handlers: { connection?: () => unknown; groups?: () => unknown }) {
  const get = vi.fn((path: string) => {
    if (path === "whatsapp/connection") {
      return Promise.resolve(handlers.connection?.() ?? connectionView());
    }
    if (path === "whatsapp/groups") {
      return Promise.resolve(handlers.groups?.() ?? []);
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

  it("renders in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    const { api } = makeApi({});
    render(<WhatsAppConfigurationWorkspace api={api} permissions={MANAGE} />);
    await screen.findByText("غير متصل");
    expect(screen.getByRole("button", { name: /ربط واتساب/ })).toBeInTheDocument();
  });
});
