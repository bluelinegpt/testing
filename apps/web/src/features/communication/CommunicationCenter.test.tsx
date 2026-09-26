// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { OperationsOrderDetail } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";
import type { CommunicationMessage, ConversationSummary } from "./communication-api.js";
import { CommunicationCenter } from "./CommunicationCenter.js";

// --- Fixtures ----------------------------------------------------------

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv-1",
    type: "order",
    participantContextType: "trader",
    participantName: "Acme Trading",
    orderId: "order-1",
    orderNumber: "ORD-1001",
    subject: null,
    status: "active",
    priority: "normal",
    lastMessageAt: "2026-08-01T10:00:00.000Z",
    lastMessagePreview: "Hello",
    unreadCount: 0,
    assignedOperatorAccountId: null,
    assignedOperatorName: null,
    ...overrides,
  };
}

function chatMessage(overrides: Partial<CommunicationMessage> = {}): CommunicationMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    senderRole: "trader",
    messageType: "text",
    text: "Where is my order?",
    clientMessageId: "client-1",
    systemEventType: null,
    sequence: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    mediaMimeType: null,
    mediaDurationSeconds: null,
    mediaSizeBytes: null,
    ...overrides,
  };
}

function orderDetail(overrides: Partial<OperationsOrderDetail> = {}): OperationsOrderDetail {
  return {
    id: "order-1",
    orderNumber: "ORD-1001",
    serialNumber: "1001",
    referenceNumber: "REF-9",
    orderDate: "2026-08-01",
    traderName: "Acme Trading",
    areaName: "Jumeirah",
    emirateNameEn: "Dubai",
    emirateNameAr: "دبي",
    assignedDriverId: null,
    assignedDriverName: null,
    assignedDriverMobile: null,
    customerName: "Sara Ahmed",
    customerAddress: "Villa 4, Street 12",
    customerMobileNumber: "0501234567",
    codAmount: "150.00",
    companyRevenue: "10.00",
    customerAmountDue: "150.00",
    deliveryStatus: "assigned_to_driver",
    driverReconciliationStatus: "not_required",
    outsourcedDriverFeeAmount: null,
    outsourcedDriverFeeOutstanding: null,
    outsourcedDriverFeePaid: null,
    outsourcedDriverFeePaymentNumbers: null,
    outsourcedDriverFeeStatus: "not_required",
    returnStatus: "none",
    serviceFee: "10.00",
    totalDeductions: null,
    traderNetPayable: "140.00",
    traderSettlementStatus: "unsettled",
    vatAmount: "0.00",
    orderProfit: "10.00",
    amountCollected: "0.00",
    attachments: [],
    events: [],
    history: [],
    internationalShipment: null,
    metadata: {
      closedAt: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      createdBy: "office.user",
      customerSecondMobileNumber: null,
      driverCost: "0.00",
      notes: null,
    },
    ...overrides,
  } as OperationsOrderDetail;
}

// --- A minimal fake WebSocket so the realtime connection has something to
//     talk to without a real server. Kept intentionally simple: tests grab
//     the latest instance to simulate `open`/`message` events by hand. ---
class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public readonly url: string;
  public closed = false;
  private readonly listeners: Record<string, ((event: { data?: string }) => void)[]> = {};

  public constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(type: string, callback: (event: { data?: string }) => void): void {
    (this.listeners[type] ??= []).push(callback);
  }

  public close(): void {
    this.closed = true;
  }

  public emitOpen(): void {
    for (const callback of this.listeners.open ?? []) callback({});
  }

  public emitMessage(payload: unknown): void {
    for (const callback of this.listeners.message ?? [])
      callback({ data: JSON.stringify(payload) });
  }
}

// --- A minimal fake MediaRecorder so the recorder control has something to
//     drive without real microphone hardware. `stop()` synchronously fires a
//     `dataavailable` event carrying a fake Blob, then a `stop` event — the
//     same sequence a real MediaRecorder produces when asked to stop. ---
class FakeMediaRecorder {
  public static instances: FakeMediaRecorder[] = [];
  public static isTypeSupported = (type: string): boolean => type === "audio/webm";
  public readonly mimeType: string;
  public state: "inactive" | "recording" = "inactive";
  private readonly listeners: Record<string, ((event: { data?: Blob }) => void)[]> = {};

  public constructor(
    public readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  public addEventListener(type: string, callback: (event: { data?: Blob }) => void): void {
    (this.listeners[type] ??= []).push(callback);
  }

  public start(): void {
    this.state = "recording";
  }

  public stop(): void {
    this.state = "inactive";
    const blob = new Blob(["fake-audio-bytes"], { type: this.mimeType });
    for (const callback of this.listeners.dataavailable ?? []) callback({ data: blob });
    for (const callback of this.listeners.stop ?? []) callback({});
  }
}

function fakeMediaStream(): MediaStream {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

function voiceMessage(overrides: Partial<CommunicationMessage> = {}): CommunicationMessage {
  return chatMessage({
    id: "voice-1",
    messageType: "voice",
    text: null,
    mediaMimeType: "audio/webm",
    mediaDurationSeconds: 12,
    mediaSizeBytes: 4096,
    ...overrides,
  });
}

// --- API mock: a single get/post/patch router keyed on the request path,
//     matching how the real ApiClient is used everywhere in this component. ---
function createApi(handlers: {
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  postMultipart?: (path: string, form: FormData) => unknown;
  getBinary?: (path: string) => unknown;
}): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (handlers.get !== undefined) return handlers.get(path);
    throw new Error(`Unhandled GET ${path}`);
  });
  const post = vi.fn(async (path: string, body?: unknown) => {
    if (handlers.post !== undefined) return handlers.post(path, body);
    // Read receipts are fire-and-forget (the component swallows their
    // errors), so an unhandled `/read` in a test that doesn't care about it
    // is harmless — only surface a loud failure for anything else.
    if (path.endsWith("/read")) return { unreadCount: 0 };
    throw new Error(`Unhandled POST ${path}`);
  });
  const patch = vi.fn(async (path: string, body?: unknown) => {
    if (handlers.patch !== undefined) return handlers.patch(path, body);
    throw new Error(`Unhandled PATCH ${path}`);
  });
  const postMultipart = vi.fn(async (path: string, form: FormData) => {
    if (handlers.postMultipart !== undefined) return handlers.postMultipart(path, form);
    throw new Error(`Unhandled POST (multipart) ${path}`);
  });
  const getBinary = vi.fn(async (path: string) => {
    if (handlers.getBinary !== undefined) return handlers.getBinary(path);
    throw new Error(`Unhandled GET (binary) ${path}`);
  });
  return { get, post, patch, postMultipart, getBinary } as unknown as ApiClient;
}

function renderCenter(
  api: ApiClient,
  overrides: Partial<{
    accessToken: string;
    currentAccountId: string;
    onNavigate: (target: string) => void;
    permissions: readonly string[];
  }> = {},
) {
  const onNavigate = overrides.onNavigate ?? vi.fn();
  render(
    <I18nextProvider i18n={i18nInstance}>
      <CommunicationCenter
        accessToken={overrides.accessToken ?? "test-token"}
        api={api}
        currentAccountId={overrides.currentAccountId ?? "office-1"}
        onNavigate={onNavigate}
        permissions={
          overrides.permissions ?? [
            "communication.operator.read",
            "communication.operator.send",
            "communication.operator.resolve",
            "communication.operator.reopen",
            "communication.operator.priority",
            "communication.operator.assign",
          ]
        }
      />
    </I18nextProvider>,
  );
  return { onNavigate };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CommunicationCenter — conversation list", () => {
  it("loads and renders conversations, with an unread badge", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation({ unreadCount: 3 })], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Conversations")).getByText("ORD-1001"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("3 unread")).toBeInTheDocument();
  });

  it("shows an empty state when there are no conversations", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) return { items: [], nextCursor: null };
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(screen.getByText("No authoritative conversations are available.")).toBeInTheDocument(),
    );
  });

  it("shows a list-load error without crashing", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) throw new Error("network down");
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("network down"));
  });

  it("redirects to the session-expired panel on a 401", async () => {
    const api = createApi({
      get: () => {
        throw new ApiError("Unauthorized", "authentication_required", 401);
      },
    });
    renderCenter(api);
    await waitFor(() => expect(screen.getByText("Your session has expired")).toBeInTheDocument());
  });

  it("debounces search input into a server-side `search` query param", async () => {
    const calls: string[] = [];
    const api = createApi({
      get: (path) => {
        calls.push(path);
        if (path.startsWith("communication/conversations?")) return { items: [], nextCursor: null };
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "Acme" },
    });
    await waitFor(() => expect(calls.some((path) => path.includes("search=Acme"))).toBe(true), {
      timeout: 2000,
    });
  });
});

describe("CommunicationCenter — active chat", () => {
  it("renders sent/received messages distinctly and marks the thread read", async () => {
    const readCalls: string[] = [];
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return {
            items: [
              chatMessage({ id: "msg-1", senderRole: "trader", text: "Where is my order?" }),
              chatMessage({
                id: "msg-2",
                senderRole: "office",
                text: "Checking now.",
                sequence: 2,
              }),
            ],
            nextCursor: null,
          };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
      post: (path) => {
        if (path === "communication/conversations/conv-1/read") readCalls.push(path);
        return { unreadCount: 0 };
      },
    });
    renderCenter(api);
    await waitFor(() => expect(screen.getByText("Where is my order?")).toBeInTheDocument());
    const sent = screen.getByText("Checking now.").closest("article");
    const received = screen.getByText("Where is my order?").closest("article");
    expect(sent).toHaveClass("sent");
    expect(received).toHaveClass("received");
    await waitFor(() => expect(readCalls.length).toBeGreaterThan(0));
  });

  it("renders message text safely — no HTML injection from a hostile payload", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return {
            items: [chatMessage({ text: "<script>window.__pwned = true;</script>" })],
            nextCursor: null,
          };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(screen.getByText("<script>window.__pwned = true;</script>")).toBeInTheDocument(),
    );
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(document.querySelector("script[data-injected]")).toBeNull();
  });

  it("shows a friendly label for an excluded voice message", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return {
            items: [chatMessage({ messageType: "voice_placeholder", text: null })],
            nextCursor: null,
          };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(screen.getByText("Voice messaging unavailable")).toBeInTheDocument(),
    );
  });
});

describe("CommunicationCenter — composer", () => {
  function apiForSend(sendImplementation: (path: string, body: unknown) => unknown) {
    return createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
      post: (path, body) => {
        if (path === "communication/conversations/conv-1/messages")
          return sendImplementation(path, body);
        return { unreadCount: 0 };
      },
    });
  }

  it("sends on Enter, appends the message, and clears the composer", async () => {
    const api = apiForSend((_path, body) => ({
      id: "msg-new",
      conversationId: "conv-1",
      senderRole: "office",
      messageType: "text",
      text: (body as { text: string }).text,
      clientMessageId: (body as { clientMessageId: string }).clientMessageId,
      systemEventType: null,
      sequence: 1,
      createdAt: "2026-08-01T10:05:00.000Z",
    }));
    renderCenter(api);
    const box = await screen.findByLabelText("Type a message…");
    fireEvent.change(box, { target: { value: "On the way" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("On the way")).toBeInTheDocument());
    expect(box).toHaveValue("");
  });

  it("keeps the draft and retries with the same idempotency key after a failure", async () => {
    let attempt = 0;
    const seenKeys: string[] = [];
    const api = apiForSend((_path, body) => {
      const { idempotencyKey } = body as { idempotencyKey: string };
      seenKeys.push(idempotencyKey);
      attempt += 1;
      if (attempt === 1) throw new Error("temporarily unavailable");
      return {
        id: "msg-new",
        conversationId: "conv-1",
        senderRole: "office",
        messageType: "text",
        text: (body as { text: string }).text,
        clientMessageId: (body as { clientMessageId: string }).clientMessageId,
        systemEventType: null,
        sequence: 1,
        createdAt: "2026-08-01T10:05:00.000Z",
      };
    });
    renderCenter(api);
    const box = await screen.findByLabelText("Type a message…");
    fireEvent.change(box, { target: { value: "Retry me" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("temporarily unavailable"),
    );
    expect(box).toHaveValue("Retry me");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Retry me")).toBeInTheDocument());
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
  });

  it("hides the composer and explains why when send permission is absent", async () => {
    const api = apiForSend(() => ({}));
    renderCenter(api, { permissions: ["communication.operator.read"] });
    await waitFor(() =>
      expect(
        screen.getByText("You do not have permission to send messages in this Company."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Type a message…")).toBeNull();
  });
});

describe("CommunicationCenter — Office actions", () => {
  it("hides resolve/reopen/priority/assign controls without permission", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api, {
      permissions: ["communication.operator.read", "communication.operator.send"],
    });
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Conversations")).getByText("ORD-1001"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Mark resolved/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assign to me/ })).toBeNull();
  });

  it("assigns to the current Operator, then offers unassign", async () => {
    let assigned: ConversationSummary = conversation();
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?"))
          return { items: [assigned], nextCursor: null };
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
      patch: (path, body) => {
        if (path === "communication/conversations/conv-1/assign") {
          const operatorAccountId =
            (body as { operatorAccountId?: string }).operatorAccountId ?? null;
          assigned = {
            ...assigned,
            assignedOperatorAccountId: operatorAccountId,
            assignedOperatorName: operatorAccountId === null ? null : "Current Operator",
          };
          return assigned;
        }
        throw new Error(`unexpected patch ${path}`);
      },
    });
    renderCenter(api, { currentAccountId: "office-1" });
    const assignButton = await screen.findByRole("button", { name: /Assign to me/ });
    fireEvent.click(assignButton);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Unassign/ })).toBeInTheDocument(),
    );
    expect(screen.getByText("Assigned to Current Operator")).toBeInTheDocument();
  });

  it("resolves the conversation and reports a failure without crashing", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
      post: (path) => {
        if (path === "communication/conversations/conv-1/resolve") {
          throw new Error("cannot resolve right now");
        }
        return { unreadCount: 0 };
      },
    });
    renderCenter(api);
    const resolveButton = await screen.findByRole("button", { name: /Mark resolved/ });
    fireEvent.click(resolveButton);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("cannot resolve right now"),
    );
  });
});

describe("CommunicationCenter — Order context panel", () => {
  it("renders the linked Order's safe context fields and navigates to Order Details", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    const { onNavigate } = renderCenter(api);
    const context = await screen.findByLabelText("Order context");
    await waitFor(() => expect(within(context).getByText("Sara Ahmed")).toBeInTheDocument());
    expect(within(context).getByText("Dubai")).toBeInTheDocument();
    expect(within(context).getByText("150.00")).toBeInTheDocument();
    fireEvent.click(within(context).getByRole("button", { name: /View Order/ }));
    expect(onNavigate).toHaveBeenCalledWith("/orders/ORD-1001");
  });

  it("shows a permission-denied note when the Order context fetch is forbidden", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) {
          throw new ApiError("Forbidden", "permission_denied", 403);
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(
        screen.getByText("You do not have permission to view this Order's details."),
      ).toBeInTheDocument(),
    );
  });

  it("shows the no-context state for a conversation with no linked Order", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return {
            items: [conversation({ orderId: null, orderNumber: null, subject: "General support" })],
            nextCursor: null,
          };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(
        screen.getByText("Select an authorized conversation to view safe Order context."),
      ).toBeInTheDocument(),
    );
  });
});

describe("CommunicationCenter — realtime", () => {
  it("opens a socket scoped to the active conversation, carrying the access token", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api, { accessToken: "secret-token" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain("conversationId=conv-1");
    expect(socket.url).toContain("token=secret-token");
    socket.emitOpen();
    await waitFor(() => expect(screen.getByText("Live")).toBeInTheDocument());
  });

  it("refreshes the conversation on a full-refresh-required signal", async () => {
    let listCalls = 0;
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          listCalls += 1;
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const initialCalls = listCalls;
    FakeWebSocket.instances[0]!.emitMessage({ type: "cursor_expired", fullRefreshRequired: true });
    await waitFor(() => expect(listCalls).toBeGreaterThan(initialCalls));
    expect(
      screen.getByText("The conversation was refreshed after a long disconnect."),
    ).toBeInTheDocument();
  });
});

describe("CommunicationCenter — voice messaging", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalMediaDevices = (globalThis.navigator as unknown as { mediaDevices?: unknown })
    .mediaDevices;

  function stubMediaDevices(getUserMedia: (...args: unknown[]) => Promise<MediaStream>) {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(getUserMedia) },
    });
  }

  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock-url"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    FakeMediaRecorder.instances = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  function apiForVoice(overrides: {
    postMultipart?: (path: string, form: FormData) => unknown;
    getBinary?: (path: string) => unknown;
    messages?: readonly CommunicationMessage[];
  }) {
    return createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: overrides.messages ?? [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
      ...(overrides.postMultipart === undefined ? {} : { postMultipart: overrides.postMultipart }),
      ...(overrides.getBinary === undefined ? {} : { getBinary: overrides.getBinary }),
    });
  }

  it("hides the mic button without send permission", async () => {
    const api = apiForVoice({});
    renderCenter(api, { permissions: ["communication.operator.read"] });
    await waitFor(() =>
      expect(
        screen.getByText("You do not have permission to send messages in this Company."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Record voice message" })).toBeNull();
  });

  it("shows the mic button when send permission is present, and does not touch the microphone on mount", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const getUserMedia = vi.fn(async () => fakeMediaStream());
    stubMediaDevices(getUserMedia);
    const api = apiForVoice({});
    renderCenter(api);
    await screen.findByRole("button", { name: "Record voice message" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("records, stops into a preview, then discards without sending", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const getUserMedia = vi.fn(async () => fakeMediaStream());
    stubMediaDevices(getUserMedia);
    const api = apiForVoice({});
    renderCenter(api);

    const micButton = await screen.findByRole("button", { name: "Record voice message" });
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(micButton);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(screen.getByText(/Recording…/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send voice message" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Send voice message" })).toBeNull();
  });

  it("cancels mid-recording without sending anything", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubMediaDevices(vi.fn(async () => fakeMediaStream()));
    const api = apiForVoice({});
    renderCenter(api);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByText(/Recording…/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Send voice message" })).toBeNull();
  });

  it("shows a translated permission-denied state without crashing, and stays retryable", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubMediaDevices(vi.fn(async () => Promise.reject(new Error("Permission denied"))));
    const api = apiForVoice({});
    renderCenter(api);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice message" }));
    await waitFor(() =>
      expect(
        screen.getByText("Microphone access is required to record a voice message."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();
  });

  it("shows the unsupported-browser message when MediaRecorder is unavailable", async () => {
    // No `MediaRecorder` global stubbed at all — the default jsdom environment.
    const api = apiForVoice({});
    renderCenter(api);
    await waitFor(() =>
      expect(
        screen.getByText("Voice recording isn't supported in this browser."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Record voice message" })).toBeNull();
  });

  it("sends the recorded voice message and appends it to the timeline", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubMediaDevices(vi.fn(async () => fakeMediaStream()));
    const captured: { path: string; form: FormData }[] = [];
    const api = apiForVoice({
      postMultipart: (path, form) => {
        captured.push({ path, form });
        return {
          id: "voice-new",
          conversationId: "conv-1",
          senderRole: "office",
          messageType: "voice",
          text: null,
          clientMessageId: form.get("clientMessageId"),
          systemEventType: null,
          sequence: 1,
          createdAt: "2026-08-01T10:05:00.000Z",
          mediaMimeType: "audio/webm",
          mediaDurationSeconds: 1,
          mediaSizeBytes: 17,
        };
      },
    });
    renderCenter(api);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByText(/Recording…/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const sendButton = await screen.findByRole("button", { name: "Send voice message" });
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument(),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toBe("communication/conversations/conv-1/voice-messages");
    expect(screen.getAllByRole("button", { name: "Play" }).length).toBeGreaterThan(0);
  });

  it("keeps the recording and retries with the same idempotency keys after a send failure", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubMediaDevices(vi.fn(async () => fakeMediaStream()));
    let attempt = 0;
    const seenKeys: {
      clientMessageId: FormDataEntryValue | null;
      idempotencyKey: FormDataEntryValue | null;
    }[] = [];
    const api = apiForVoice({
      postMultipart: (_path, form) => {
        seenKeys.push({
          clientMessageId: form.get("clientMessageId"),
          idempotencyKey: form.get("idempotencyKey"),
        });
        attempt += 1;
        if (attempt === 1) throw new Error("temporarily unavailable");
        return {
          id: "voice-retry",
          conversationId: "conv-1",
          senderRole: "office",
          messageType: "voice",
          text: null,
          clientMessageId: form.get("clientMessageId"),
          systemEventType: null,
          sequence: 1,
          createdAt: "2026-08-01T10:05:00.000Z",
          mediaMimeType: "audio/webm",
          mediaDurationSeconds: 1,
          mediaSizeBytes: 17,
        };
      },
    });
    renderCenter(api);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByText(/Recording…/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send voice message" }));

    await waitFor(() => expect(screen.getByText("temporarily unavailable")).toBeInTheDocument());
    const retryButton = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument(),
    );
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toEqual(seenKeys[1]);
  });

  it("lazily fetches audio on Play, shows Pause, and pauses another playing message", async () => {
    const getBinary = vi.fn(async (path: string) => {
      if (path === "communication/messages/voice-1/media") {
        return new Blob(["one"], { type: "audio/webm" });
      }
      if (path === "communication/messages/voice-2/media") {
        return new Blob(["two"], { type: "audio/webm" });
      }
      throw new Error(`unexpected ${path}`);
    });
    const api = apiForVoice({
      messages: [voiceMessage({ id: "voice-1" }), voiceMessage({ id: "voice-2", sequence: 2 })],
      getBinary,
    });
    renderCenter(api);

    const playButtons = await screen.findAllByRole("button", { name: "Play" });
    expect(playButtons).toHaveLength(2);
    expect(getBinary).not.toHaveBeenCalled();

    fireEvent.click(playButtons[0]!);
    await waitFor(() => expect(getBinary).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1));

    const remainingPlay = screen.getByRole("button", { name: "Play" });
    fireEvent.click(remainingPlay);
    await waitFor(() => expect(getBinary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1));
    // The first player fell back to "Play" once the second started (only one
    // plays at a time), and only one fetch happened per message (no re-fetch).
    expect(screen.getAllByRole("button", { name: "Play" })).toHaveLength(1);
  });

  it("shows a translated audio-unavailable state on playback fetch failure, without crashing", async () => {
    const getBinary = vi.fn(async () => Promise.reject(new Error("expired session")));
    const api = apiForVoice({ messages: [voiceMessage()], getBinary });
    renderCenter(api);

    fireEvent.click(await screen.findByRole("button", { name: "Play" }));
    await waitFor(() => expect(screen.getByText("Audio unavailable")).toBeInTheDocument());
  });

  it("renders the translated 'Voice message' label instead of the raw marker in the conversation list", async () => {
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return {
            items: [conversation({ lastMessagePreview: "voice_message" })],
            nextCursor: null,
          };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          return { items: [], nextCursor: null };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Conversations")).getByText("Voice message"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("voice_message")).toBeNull();
  });

  it("renders a voice message that arrives via the realtime refresh flow", async () => {
    let messagesCall = 0;
    // The messages endpoint returns the voice message only from the second
    // call onward — the one triggered by the realtime `message.created` event
    // (the same refetch-newest-page pattern already used for text messages).
    const api = createApi({
      get: (path) => {
        if (path.startsWith("communication/conversations?")) {
          return { items: [conversation()], nextCursor: null };
        }
        if (path.startsWith("communication/conversations/conv-1/messages")) {
          messagesCall += 1;
          return {
            items: messagesCall === 1 ? [] : [voiceMessage()],
            nextCursor: null,
          };
        }
        if (path.startsWith("operations/order-details/")) return orderDetail();
        throw new Error(`unexpected ${path}`);
      },
    });
    renderCenter(api);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]!.emitMessage({
      type: "event",
      event: {
        sequence: "1",
        type: "message.created",
        entityType: "message",
        entityId: "voice-1",
        payload: {},
        createdAt: "2026-08-01T10:06:00.000Z",
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());
  });
});
