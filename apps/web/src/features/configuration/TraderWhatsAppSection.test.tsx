import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { SessionAccessProvider } from "../../app/SessionAccessContext.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderWhatsAppSection } from "./TraderWhatsAppSection.js";

const TRADER_ID = "10000000-0000-4000-8000-000000000001";

function settingsView(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    configuredAt: null,
    destinationType: "group",
    groupNameSnapshot: null,
    messageLanguage: "both",
    notificationsEnabled: false,
    providerGroupId: null,
    traderId: TRADER_ID,
    ...overrides,
  };
}

function connectedView(status = "connected") {
  return {
    connectedAt: "2026-08-31T18:00:00Z",
    connectedPhoneNumber: "+971501234567",
    disconnectReason: null,
    lastConnectedAt: "2026-08-31T18:00:00Z",
    lastDisconnectedAt: null,
    lastHealthCheckAt: null,
    providerType: "baileys",
    qr: null,
    qrAvailable: false,
    requiresQrScan: false,
    status,
  };
}

function makeApi(handlers: {
  settings?: () => unknown;
  connection?: () => unknown;
  groups?: () => unknown;
  notifications?: () => unknown;
  postResult?: () => Promise<unknown>;
}) {
  const get = vi.fn((path: string) => {
    if (path === `whatsapp/traders/${TRADER_ID}/settings`) {
      return Promise.resolve(handlers.settings?.() ?? settingsView());
    }
    if (path === "whatsapp/connection") {
      return Promise.resolve(handlers.connection?.() ?? connectedView());
    }
    if (path === "whatsapp/groups") {
      return Promise.resolve(
        handlers.groups?.() ?? [
          { id: "111111@g.us", name: "Dana vs NoorStore", participantCount: 4 },
          { id: "222222@g.us", name: "Noor Store Operations", participantCount: 3 },
        ],
      );
    }
    if (path === `whatsapp/traders/${TRADER_ID}/notifications`) {
      return Promise.resolve(handlers.notifications?.() ?? []);
    }
    return Promise.reject(new Error(`unexpected get ${path}`));
  });
  const put = vi.fn(() => Promise.resolve(settingsView()));
  const post = vi.fn(
    () =>
      handlers.postResult?.() ??
      Promise.resolve({
        failureCode: null,
        messageId: "m1",
        providerMessageId: "3EB0X",
        status: "sent",
      }),
  );
  const del = vi.fn(() => Promise.resolve(settingsView()));
  return { api: { delete: del, get, post, put } as unknown as ApiClient, del, get, post, put };
}

function renderSection(
  api: ApiClient,
  permissions: readonly string[] = ["whatsapp.trader_settings.manage", "whatsapp.history.view"],
) {
  return render(
    <SessionAccessProvider
      value={{ companyId: "company-1", navigate: () => undefined, permissions }}
    >
      <TraderWhatsAppSection api={api} traderId={TRADER_ID} traderName="Noor Store" />
    </SessionAccessProvider>,
  );
}

describe("TraderWhatsAppSection", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows the unconfigured defaults: disabled, no group, language Both", async () => {
    const { api } = makeApi({});
    renderSection(api);
    await screen.findByText("No group selected");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByLabelText("Message language")).toHaveValue("both");
  });

  it("blocks enabling notifications without a selected group", async () => {
    const { api, put } = makeApi({});
    renderSection(api);
    await screen.findByText("No group selected");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Select a WhatsApp group before enabling notifications.");
    expect(put).not.toHaveBeenCalled();
  });

  it("selects a group through the searchable picker and persists id + name snapshot", async () => {
    const { api, put } = makeApi({});
    renderSection(api);
    await screen.findByText("No group selected");
    fireEvent.click(screen.getByRole("button", { name: "Select WhatsApp Group" }));
    await screen.findByRole("radio", { name: /Dana vs NoorStore/ });
    fireEvent.change(screen.getByPlaceholderText("Search groups..."), {
      target: { value: "Operations" },
    });
    expect(screen.queryByRole("radio", { name: /Dana vs NoorStore/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Noor Store Operations/ }));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(`whatsapp/traders/${TRADER_ID}/settings`, {
        groupNameSnapshot: "Noor Store Operations",
        messageLanguage: "both",
        notificationsEnabled: true,
        providerGroupId: "222222@g.us",
      }),
    );
  });

  it("requires confirmation before replacing an existing group mapping", async () => {
    const { api, put } = makeApi({
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api);
    await screen.findByText("Dana vs NoorStore");
    fireEvent.click(screen.getByRole("button", { name: "Select WhatsApp Group" }));
    await screen.findByRole("radio", { name: /Noor Store Operations/ });
    fireEvent.click(screen.getByRole("radio", { name: /Noor Store Operations/ }));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Change WhatsApp group?");
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change Group" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        `whatsapp/traders/${TRADER_ID}/settings`,
        expect.objectContaining({ providerGroupId: "222222@g.us" }),
      ),
    );
  });

  it("removes the mapping only after confirmation, via the dedicated endpoint", async () => {
    const { api, del } = makeApi({
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api);
    await screen.findByText("Dana vs NoorStore");
    fireEvent.click(screen.getByRole("button", { name: "Remove Group" }));
    await screen.findByText(/Future WhatsApp notifications will be disabled/);
    expect(del).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Remove Group" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(`whatsapp/traders/${TRADER_ID}/settings/group`),
    );
  });

  it("sends exactly one test message per click, blocking double-submit while in flight", async () => {
    let resolveSend: ((value: unknown) => void) | undefined;
    const { api, post } = makeApi({
      postResult: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api);
    await screen.findByText("Dana vs NoorStore");
    const button = await screen.findByRole("button", { name: /Send Test Message/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      `whatsapp/traders/${TRADER_ID}/test-message`,
      expect.objectContaining({ clientRequestId: expect.any(String) }),
    );
    resolveSend?.({
      failureCode: null,
      messageId: "m1",
      providerMessageId: "3EB0X",
      status: "sent",
    });
    await screen.findByText("Test message sent successfully.");
  });

  it("disables the test message and warns when WhatsApp is not connected", async () => {
    const { api } = makeApi({
      connection: () => connectedView("disconnected"),
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api);
    await screen.findByText(
      "WhatsApp is not connected. Reconnect before selecting or testing a group.",
    );
    expect(screen.getByRole("button", { name: /Send Test Message/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select WhatsApp Group" })).toBeDisabled();
  });

  it("flags a mapped group that discovery no longer returns, without removing it", async () => {
    const { api, del, put } = makeApi({
      groups: () => [{ id: "999999@g.us", name: "Some Other Group", participantCount: 2 }],
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api);
    await screen.findByText("Mapped group not currently found");
    expect(screen.getByText("Dana vs NoorStore")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("renders history including a test message with its safe status", async () => {
    const { api } = makeApi({
      notifications: () => [
        {
          createdAt: "2026-08-31T21:10:00Z",
          failureCode: null,
          groupNameSnapshot: "Dana vs NoorStore",
          id: "n1",
          messageLanguage: "both",
          messageType: "test",
          orderNumber: null,
          orderStatus: null,
          status: "sent",
        },
      ],
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api);
    await screen.findByText("Test Message");
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getAllByText("Dana vs NoorStore").length).toBeGreaterThan(0);
  });

  it("shows a read-only view without the manage permission", async () => {
    const { api } = makeApi({
      settings: () =>
        settingsView({
          configured: true,
          groupNameSnapshot: "Dana vs NoorStore",
          notificationsEnabled: true,
          providerGroupId: "111111@g.us",
        }),
    });
    renderSection(api, ["whatsapp.history.view"]);
    await screen.findByText("Dana vs NoorStore");
    expect(screen.queryByRole("button", { name: "Select WhatsApp Group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send Test Message/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
