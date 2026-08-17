import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { CreateOrderDialog } from "./CreateOrderDialog.js";

const area = {
  code: "DXB",
  createdAt: "2026-07-15",
  emirateCode: "DXB",
  emirateId: "50000000-0000-4000-8000-000000000001",
  emirateNameAr: "دبي",
  emirateNameEn: "Dubai",
  id: "10000000-0000-4000-8000-000000000001",
  isActive: true,
  nameAr: "دبي",
  nameEn: "Dubai",
};
const trader = {
  code: "TR-1",
  id: "20000000-0000-4000-8000-000000000001",
  mobileNumber: "971500000000",
  nameAr: "تاجر الاختبار",
  nameEn: "Test Trader",
};
const customer = {
  address: "Building 4, Dubai",
  addressId: "30000000-0000-4000-8000-000000000001",
  areaCode: "DXB",
  areaId: area.id,
  areaName: "Dubai",
  areaNameAr: "دبي",
  code: "CUS-000001",
  customerReference: null,
  deliveryInstructions: "Call on arrival",
  deliveryNotes: null,
  email: null,
  emirateId: area.emirateId,
  emirateNameAr: area.emirateNameAr,
  emirateNameEn: area.emirateNameEn,
  id: "40000000-0000-4000-8000-000000000001",
  latitude: null,
  locationLink: null,
  longitude: null,
  mobileNumber: "971506468441",
  name: "Aisha",
  secondMobileNumber: null,
};
const quote = {
  additionalFees: "0.00",
  additionalFeeVatAmount: "0.00",
  codAmount: "100.00",
  companyRevenue: "10.00",
  configuredServiceFee: "10.00",
  customerAmountDue: "100.00",
  orderProfit: "10.00",
  overrideApplied: false,
  serviceFee: "10.00",
  serviceFeeVatAmount: "0.00",
  totalDeductions: "10.00",
  traderNetPayable: "90.00",
  vatAmount: "0.00",
  vatEnabled: false,
  vatPriceMode: null,
  vatRate: "0.0000",
};

/**
 * TEMPORARY diagnostics for the intermittent full-suite failure where the
 * trader listbox renders open but empty. Test-only: nothing is added to
 * production code, and the trace is printed solely when a test fails.
 */
const trace: string[] = [];
let sequence = 0;
const mark = (event: string, detail: Record<string, unknown> = {}) => {
  const pairs = Object.entries(detail)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(" ");
  trace.push(`#${(sequence += 1)} +${Math.round(performance.now())}ms ${event} ${pairs}`.trim());
};

function dumpTrace(context: string) {
  const bodyText = document.body.textContent ?? "";
  const inputs = document.querySelectorAll(
    '[placeholder="Search by Trader code, name, or mobile"]',
  );
  const listboxes = document.querySelectorAll('[role="listbox"]');
  const options = document.querySelectorAll('[role="option"]');
  const header = [
    "",
    "================ CreateOrderDialog diagnostics ================",
    `context:            ${context}`,
    `timers:             ${vi.isFakeTimers() ? "FAKE" : "real"}`,
    `trader inputs:      ${inputs.length}`,
    `dialogs mounted:    ${document.querySelectorAll('[role="dialog"]').length}`,
    `listboxes:          ${listboxes.length}`,
    `options rendered:   ${options.length}`,
    `shows empty text:   ${bodyText.includes("No Traders found")}`,
    `shows loading text: ${bodyText.includes("Loading")}`,
    `RTL containers:     ${document.body.children.length}`,
    "---------------- api.get call trace ----------------",
    ...trace,
    "==============================================================",
    "",
  ].join("\n");
  // Vitest forwards console output into the reporter, which the failure
  // harness preserves; the web package has no node types for process.stdout.
  console.error(header);
}

function setup() {
  let resolveOrder: ((value: unknown) => void) | undefined;
  const api = {
    get: vi.fn((path: string, signal?: AbortSignal) => {
      const callId = sequence + 1;
      const query = /[?&]search=([^&]*)/.exec(path)?.[1] ?? "(none)";
      mark("api.get called", {
        path: path.split("?")[0],
        query: `"${query}"`,
        abortedAtCall: signal?.aborted ?? "no-signal",
      });
      if (path === "configuration/emirates") {
        return Promise.resolve([
          {
            code: "DXB",
            id: "50000000-0000-4000-8000-000000000001",
            nameAr: "دبي",
            nameEn: "Dubai",
          },
        ]);
      }
      if (path === "operations/orders/next-serial-number") {
        return Promise.resolve({ serialNumber: "000123" });
      }
      if (path.startsWith("operations/orders/identifier-availability")) {
        return Promise.resolve({
          referenceNumberAvailable: true,
          serialNumberAvailable: true,
        });
      }
      if (path.startsWith("configuration/customers/CUS-000001")) {
        return Promise.resolve({ addresses: [{ ...customer, isActive: true, isDefault: true }] });
      }
      const items = path.startsWith("operations/traders")
        ? [trader]
        : path.startsWith("configuration/customers")
          ? [customer]
          : [area];
      mark("api.get resolving", {
        call: callId,
        path: path.split("?")[0],
        query: `"${query}"`,
        itemCount: items.length,
        abortedBeforeApply: signal?.aborted ?? "no-signal",
      });
      return Promise.resolve({ hasMore: false, items, total: 1 });
    }),
    post: vi.fn((path: string, body?: unknown, headers?: Readonly<Record<string, string>>) => {
      void body;
      void headers;
      if (path.endsWith("/quote")) return Promise.resolve(quote);
      if (path === "configuration/areas") return Promise.resolve(area);
      return new Promise((resolve) => {
        resolveOrder = resolve;
      });
    }),
  };
  const onSaved = vi.fn().mockResolvedValue(undefined);
  mark("dialog render", {
    existingTraderInputs: document.querySelectorAll(
      '[placeholder="Search by Trader code, name, or mobile"]',
    ).length,
  });
  render(
    <CreateOrderDialog
      api={api as unknown as ApiClient}
      drivers={[]}
      onClose={vi.fn()}
      onSaved={onSaved}
      permissions={["users_roles.manage", "orders.override_service_fee"]}
      searchDebounceMs={0}
    />,
  );
  return { api, onSaved, resolve: (value: unknown) => resolveOrder?.(value) };
}

async function selectTraderAndCustomer() {
  fireEvent.change(screen.getByLabelText("Serial Number"), { target: { value: "000123" } });
  fireEvent.change(screen.getByLabelText("Reference Number"), { target: { value: "REF-A1" } });
  const traderInput = screen.getByPlaceholderText("Search by Trader code, name, or mobile");
  fireEvent.focus(traderInput);
  fireEvent.change(traderInput, { target: { value: "TR-1" } });
  const traderOption = await screen.findByRole("option", { name: /Test Trader/ });
  fireEvent.keyDown(traderInput, { key: "ArrowDown" });
  // Wait for the highlight to settle before Enter, then fire it synchronously
  // so no render can interleave. Guards the keyboard path against selecting
  // nothing when the option list is still settling under parallel test load.
  await waitFor(() => expect(traderOption).toHaveAttribute("aria-selected", "true"));
  fireEvent.keyDown(traderInput, { key: "Enter" });
  const customerInput = screen.getByPlaceholderText("Search or type a new Customer Name");
  fireEvent.focus(customerInput);
  fireEvent.change(customerInput, { target: { value: "CUS-000001" } });
  fireEvent.click(await screen.findByRole("option", { name: /Aisha/ }));
}

// Selects only the Trader (and Serial), leaving the Customer to be typed as a
// new record — the fast inline-capture path.
async function selectTraderOnly() {
  fireEvent.change(screen.getByLabelText("Serial Number"), { target: { value: "000123" } });
  const traderInput = screen.getByPlaceholderText("Search by Trader code, name, or mobile");
  fireEvent.focus(traderInput);
  fireEvent.change(traderInput, { target: { value: "TR-1" } });
  const traderOption = await screen.findByRole("option", { name: /Test Trader/ });
  fireEvent.keyDown(traderInput, { key: "ArrowDown" });
  await waitFor(() => expect(traderOption).toHaveAttribute("aria-selected", "true"));
  fireEvent.keyDown(traderInput, { key: "Enter" });
}

// Types a new Customer Name without choosing a suggestion, then picks the
// Emirate and Area (enabled because no existing Customer is selected).
async function typeNewCustomerAndArea(name: string) {
  const customerInput = screen.getByPlaceholderText("Search or type a new Customer Name");
  fireEvent.focus(customerInput);
  fireEvent.change(customerInput, { target: { value: name } });
  fireEvent.blur(customerInput);
  const emirate = await screen.findByLabelText("Emirate");
  fireEvent.change(emirate, { target: { value: area.emirateId } });
  const areaInput = screen.getByPlaceholderText("Search by Area name or code");
  fireEvent.focus(areaInput);
  fireEvent.change(areaInput, { target: { value: "DXB" } });
  const container = document.querySelector('[data-field="area"]');
  if (container === null) throw new Error("Area field container missing");
  // Scope to the Area combobox listbox so the Emirate <select>'s identically
  // named "Dubai" option is not matched.
  await waitFor(() =>
    expect(container.querySelector('[role="listbox"] [role="option"]')).not.toBeNull(),
  );
  const listbox = container.querySelector('[role="listbox"]');
  if (listbox === null) throw new Error("Area listbox not open");
  fireEvent.click(within(listbox as HTMLElement).getByRole("option", { name: "Dubai" }));
}

describe("CreateOrderDialog", () => {
  beforeEach(async (context) => {
    // Record whether the previous test's DOM was torn down before this one ran.
    const leftoverInputs = document.querySelectorAll(
      '[placeholder="Search by Trader code, name, or mobile"]',
    ).length;
    trace.length = 0;
    sequence = 0;
    mark("test start", {
      name: context.task.name.slice(0, 40),
      leftoverTraderInputs: leftoverInputs,
      cleanupRanAfterPreviousTest: leftoverInputs === 0,
      timers: vi.isFakeTimers() ? "FAKE" : "real",
    });
    await i18nInstance.changeLanguage("en");
  });

  // Print the trace only for a failing test, so passing runs stay quiet and the
  // detail lands in the preserved harness log.
  afterEach((context) => {
    if (context.task.result?.state === "fail") dumpTrace(context.task.name);
  });

  it("creates a Collect Order without mandatory Customer details", async () => {
    const { api, resolve } = setup();
    await selectTraderOnly();
    fireEvent.change(screen.getByLabelText(/Order type/i), {
      target: { value: "collect_order" },
    });
    expect(screen.getByLabelText(/Customer name/i)).not.toBeRequired();
    expect(screen.getByLabelText(/^Mobile number$/i)).not.toBeRequired();
    expect(screen.queryByLabelText(/Assigned driver/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    const creates = api.post.mock.calls.filter(([path]) => path === "operations/orders");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toMatchObject({ orderType: "collect_order" });
    expect(creates[0]?.[1]).not.toHaveProperty("customerName");
    expect(creates[0]?.[1]).not.toHaveProperty("customerMobileNumber");
    expect(creates[0]?.[1]).not.toHaveProperty("inlineCustomer");
    expect(creates[0]?.[1]).not.toHaveProperty("areaId");
    expect(creates[0]?.[1]).not.toHaveProperty("driverId");
    resolve({ orderNumber: "ORD-000500", serialNumber: "000123" });
  });

  it("selecting an existing Customer populates its saved details in the Order form", async () => {
    setup();
    // There is no separate read-only name field: the Customer field itself is
    // the single Name entry (searchable, and typeable for a new Customer).
    expect(screen.queryByTestId("customer-name")).not.toBeInTheDocument();

    await selectTraderAndCustomer();

    // The Customer field shows the selected name and the saved details populate.
    expect(screen.getByPlaceholderText("Search or type a new Customer Name")).toHaveValue("Aisha");
    expect(screen.getByLabelText("Customer address")).toHaveValue("Building 4, Dubai");
    const mobile = screen.getAllByPlaceholderText(/9715XXXXXXXX/)[0];
    expect(mobile).toHaveValue("971506468441");
  });

  it("searches by keyboard, treats mobile format as advisory, creates unassigned, prevents duplicates", async () => {
    const { api, onSaved, resolve } = setup();
    await selectTraderAndCustomer();
    const mobile = screen.getAllByPlaceholderText(/9715XXXXXXXX/)[0];
    if (mobile === undefined) throw new Error("Primary mobile input was not rendered");
    fireEvent.change(mobile, { target: { value: "0406468441" } });
    // An unconventional value is advisory only: warning guidance, not a blocking
    // error, and the field is not marked invalid.
    expect(
      screen.getByText("Recommended UAE format: 0506468442 or 971506468442."),
    ).toBeInTheDocument();
    expect(mobile).not.toHaveAttribute("aria-invalid", "true");
    // The mobile is sent exactly as typed (trimmed); the API normalizes it.
    fireEvent.change(mobile, { target: { value: "0506468441" } });
    fireEvent.change(screen.getByLabelText("Customer address"), { target: { value: "Dubai" } });
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });

    // Wait for the pricing quote to resolve (Amount due to trader shown) before
    // submitting; the button is enabled but validation requires a resolved fee.
    await screen.findAllByText("AED 90.00");
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    fireEvent.click(screen.getByRole("button", { name: /Creating Order/ }));
    const creates = api.post.mock.calls.filter(([path]) => path === "operations/orders");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toMatchObject({
      additionalFees: 0,
      customerMobileNumber: "0506468441",
      referenceNumber: "REF-A1",
      serialNumber: "000123",
      serviceFee: undefined,
    });
    expect(creates[0]?.[1]).not.toHaveProperty("driverId");
    expect(creates[0]?.[2]).toHaveProperty("X-Idempotency-Key");
    resolve({ orderNumber: "ORD-000123", serialNumber: "000123" });
    expect(await screen.findByText(/000123/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("creates an Order without a Reference Number while keeping Serial Number required", async () => {
    const { api, resolve } = setup();
    await selectTraderAndCustomer();
    fireEvent.change(screen.getByLabelText("Reference Number"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });

    await screen.findAllByText("AED 90.00");
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "operations/orders",
        expect.objectContaining({
          referenceNumber: undefined,
          serialNumber: "000123",
        }),
        expect.objectContaining({ "X-Idempotency-Key": expect.any(String) }),
      ),
    );
    resolve({ orderNumber: "ORD-000124", referenceNumber: null, serialNumber: "000123" });
    expect(await screen.findByText(/000123/)).toBeInTheDocument();
  });

  it("creates and automatically selects a missing Area only with the approved permission", async () => {
    const { api } = setup();
    const emirate = await screen.findByLabelText("Emirate");
    fireEvent.change(emirate, { target: { value: "50000000-0000-4000-8000-000000000001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Area" }));
    fireEvent.change(screen.getByLabelText("Area Name"), { target: { value: "Dubai" } });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("configuration/areas", {
        emirateId: "50000000-0000-4000-8000-000000000001",
        nameAr: "",
        nameEn: "Dubai",
        notes: "",
      }),
    );
    // The created Area is auto-selected in the Area combobox, shown by name and
    // in the user's Search-and-Display language (English here) with no code.
    const areaInput = await screen.findByPlaceholderText("Search by Area name or code");
    await waitFor(() => expect(areaInput).toHaveValue("Dubai"));
  });

  /* Free Order. The blocker this feature removes is real: an unpriced
     Trader/Area otherwise refuses the quote and the operator has no way to say
     "this one is deliberately free". */
  const unpricedApi = () => ({
    get: vi.fn((path: string) => {
      if (path.startsWith("operations/orders/identifier-availability")) {
        return Promise.resolve({ referenceNumberAvailable: true, serialNumberAvailable: true });
      }
      if (path === "configuration/emirates") {
        return Promise.resolve([
          {
            code: "DXB",
            id: area.emirateId,
            nameAr: area.emirateNameAr,
            nameEn: area.emirateNameEn,
          },
        ]);
      }
      if (path === "operations/orders/next-serial-number") {
        return Promise.resolve({ serialNumber: "000123" });
      }
      if (path.startsWith("configuration/customers/CUS-000001")) {
        return Promise.resolve({ addresses: [{ ...customer, isActive: true, isDefault: true }] });
      }
      // Same dispatch as `setup()`: Trader search lives under operations/.
      const items = path.startsWith("operations/traders")
        ? [trader]
        : path.startsWith("configuration/customers")
          ? [customer]
          : [area];
      return Promise.resolve({ hasMore: false, items, total: 1 });
    }),
    post: vi.fn((path: string) => {
      // No configured price: the quote always refuses.
      if (path === "operations/orders/quote") {
        return Promise.reject(new ApiError("no price", "pricing_not_configured", 422));
      }
      return Promise.resolve({ orderNumber: "ORD-000300" });
    }),
  });

  const renderWith = (api: ReturnType<typeof unpricedApi>) =>
    render(
      <CreateOrderDialog
        api={api as unknown as ApiClient}
        drivers={[]}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        permissions={["users_roles.manage"]}
        searchDebounceMs={0}
      />,
    );

  it("offers a Free Order checkbox, unchecked by default", async () => {
    renderWith(unpricedApi());
    await selectTraderAndCustomer();
    const checkbox = screen.getByLabelText("Free Order");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
    // The reason only exists once the decision is made.
    expect(screen.queryByLabelText("Free Order Reason")).not.toBeInTheDocument();
  });

  it("zeroes and locks the money when Free Order is checked", async () => {
    renderWith(unpricedApi());
    await selectTraderAndCustomer();
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "300" } });
    fireEvent.click(screen.getByLabelText("Free Order"));

    const cod = screen.getByLabelText("COD amount");
    // Set for the operator rather than typed by them, and no longer editable.
    expect(cod).toHaveValue(0);
    expect(cod).toBeDisabled();
    expect(screen.getByText(/this Order is free/i)).toBeInTheDocument();
    expect(await screen.findByLabelText("Free Order Reason")).toBeInTheDocument();
  });

  it("does not let unresolved Trader pricing block a Free Order", async () => {
    const api = unpricedApi();
    renderWith(api);
    await selectTraderAndCustomer();
    // The pricing dead end is present for a normal Order...
    expect(await screen.findByText(/could not be resolved/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Free Order"));
    const reason = await screen.findByLabelText("Free Order Reason");
    fireEvent.change(reason, {
      target: { value: "Free delivery test" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create order" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    // ...and does not stop this one, because it was never a pricing question.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "operations/orders",
        expect.objectContaining({
          codAmount: 0,
          freeOrderReason: "Free delivery test",
          isFreeOrder: true,
        }),
        expect.objectContaining({ "X-Idempotency-Key": expect.any(String) }),
      ),
    );
  });

  it("blocks a Free Order with a blank reason before it reaches the server", async () => {
    const api = unpricedApi();
    renderWith(api);
    await selectTraderAndCustomer();
    fireEvent.click(screen.getByLabelText("Free Order"));
    const reason = await screen.findByLabelText("Free Order Reason");
    fireEvent.change(reason, { target: { value: "   " } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create order" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    const reasonErrors = await screen.findAllByText("Enter a reason for the Free Order.");
    expect(reasonErrors).toHaveLength(2);
    expect(api.post).not.toHaveBeenCalledWith("operations/orders", expect.anything());
  });

  it("hands pricing back and drops the reason when Free Order is unchecked", async () => {
    renderWith(unpricedApi());
    await selectTraderAndCustomer();
    fireEvent.click(screen.getByLabelText("Free Order"));
    fireEvent.change(screen.getByLabelText("Free Order Reason"), {
      target: { value: "Free delivery test" },
    });
    fireEvent.click(screen.getByLabelText("Free Order"));

    // COD editable again, reason gone, and the normal pricing dead end returns
    // rather than a stale zero fee being kept.
    expect(screen.getByLabelText("COD amount")).toBeEnabled();
    expect(screen.queryByLabelText("Free Order Reason")).not.toBeInTheDocument();
    expect(await screen.findByText(/could not be resolved/i)).toBeInTheDocument();
  });

  it("lets the operator enter a manual fee when the Trader has no configured price", async () => {
    // The quote endpoint refuses until a manual service fee is supplied, then
    // prices the order manually — the resolver's no-configured-price path.
    const quotes: unknown[] = [];
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders/identifier-availability")) {
          return Promise.resolve({
            referenceNumberAvailable: true,
            serialNumberAvailable: true,
          });
        }
        if (path === "configuration/emirates") {
          return Promise.resolve([
            {
              code: "DXB",
              id: area.emirateId,
              nameAr: area.emirateNameAr,
              nameEn: area.emirateNameEn,
            },
          ]);
        }
        if (path.startsWith("configuration/customers/CUS-000001")) {
          return Promise.resolve({ addresses: [{ ...customer, isActive: true, isDefault: true }] });
        }
        const items = path.startsWith("operations/traders")
          ? [trader]
          : path.startsWith("configuration/customers")
            ? [customer]
            : [area];
        return Promise.resolve({ hasMore: false, items, total: 1 });
      }),
      post: vi.fn((path: string, body?: { serviceFee?: number }) => {
        if (path.endsWith("/quote")) {
          quotes.push(body);
          if (body?.serviceFee === undefined) {
            return Promise.reject(new ApiError("no price", "pricing_not_configured", 422));
          }
          return Promise.resolve({ ...quote, configuredServiceFee: String(body.serviceFee) });
        }
        return Promise.resolve({ orderNumber: "ORD-000200" });
      }),
    };
    render(
      <CreateOrderDialog
        api={api as unknown as ApiClient}
        drivers={[]}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        permissions={["users_roles.manage"]}
        searchDebounceMs={0}
      />,
    );
    await selectTraderAndCustomer();

    // The missing-price notice and manual fields appear instead of a dead end.
    expect(await screen.findByText(/could not be resolved/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Service fee (manual)"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Reason for manual fee"), {
      target: { value: "Agreed rate" },
    });

    // The re-run quote carries the manual fee + reason and now succeeds.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "operations/orders/quote",
        expect.objectContaining({ serviceFee: 15, serviceFeeOverrideReason: "Agreed rate" }),
      ),
    );
    // The manual field stays visible (so the fee can still be adjusted) and the
    // resolved fee is reflected in the read-only Service fee field.
    expect(screen.getByLabelText("Service fee (manual)")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Service fee")).toHaveValue("15"));
  });

  it("prices a manual order with only a fee, no reason required", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders/identifier-availability")) {
          return Promise.resolve({
            referenceNumberAvailable: true,
            serialNumberAvailable: true,
          });
        }
        if (path === "configuration/emirates") {
          return Promise.resolve([
            {
              code: "DXB",
              id: area.emirateId,
              nameAr: area.emirateNameAr,
              nameEn: area.emirateNameEn,
            },
          ]);
        }
        if (path.startsWith("configuration/customers/CUS-000001")) {
          return Promise.resolve({ addresses: [{ ...customer, isActive: true, isDefault: true }] });
        }
        const items = path.startsWith("operations/traders")
          ? [trader]
          : path.startsWith("configuration/customers")
            ? [customer]
            : [area];
        return Promise.resolve({ hasMore: false, items, total: 1 });
      }),
      post: vi.fn((path: string, body?: { serviceFee?: number }) => {
        if (path.endsWith("/quote")) {
          if (body?.serviceFee === undefined) {
            return Promise.reject(new ApiError("no price", "pricing_not_configured", 422));
          }
          return Promise.resolve({ ...quote, configuredServiceFee: String(body.serviceFee) });
        }
        return Promise.resolve({ orderNumber: "ORD-000201" });
      }),
    };
    render(
      <CreateOrderDialog
        api={api as unknown as ApiClient}
        drivers={[]}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        permissions={["users_roles.manage"]}
        searchDebounceMs={0}
      />,
    );
    await selectTraderAndCustomer();
    await screen.findByText(/could not be resolved/i);
    // Fee alone, no reason — the quote must still succeed.
    fireEvent.change(screen.getByLabelText("Service fee (manual)"), { target: { value: "12.5" } });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "operations/orders/quote",
        expect.objectContaining({ serviceFee: 12.5, serviceFeeOverrideReason: undefined }),
      ),
    );
    await waitFor(() => expect(screen.getByLabelText("Service fee")).toHaveValue("12.5"));
  });
});

describe("CreateOrderDialog validation (Phase 3)", () => {
  beforeEach(async (context) => {
    trace.length = 0;
    sequence = 0;
    mark("test start", { name: context.task.name.slice(0, 40) });
    await i18nInstance.changeLanguage("en");
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") dumpTrace(context.task.name);
  });

  it("keeps Create Order enabled and shows an accessible summary that focuses the first field", async () => {
    setup();
    const button = screen.getByRole("button", { name: "Create order" });
    // The button is not silently disabled on an incomplete form.
    expect(button).toBeEnabled();
    fireEvent.click(button);

    // The summary lists the missing fields and each item is actionable.
    expect(
      await screen.findByText(
        "Unable to create the Order. Please complete or correct the following fields:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select a valid Trader." })).toBeInTheDocument();
    // A submit may occur while the generated Serial Number request is still
    // settling. The ordered validation focus remains deterministic.
    expect(document.activeElement).toBe(document.getElementById("order-serial"));
  });

  it("clicking a summary item focuses the related field", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    const traderItem = await screen.findByRole("button", { name: "Select a valid Trader." });
    fireEvent.click(traderItem);
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Search by Trader code, name, or mobile"),
    );
  });

  it("rejects a non-integer Package count", async () => {
    setup();
    await selectTraderAndCustomer();
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });
    await screen.findAllByText("AED 90.00");
    fireEvent.change(screen.getByLabelText("Packages"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    expect(
      await screen.findByRole("button", { name: "Packages must be a whole number of 1 or more." }),
    ).toBeInTheDocument();
  });

  it("shows an advisory for an unconventional second mobile without blocking", async () => {
    setup();
    const second = screen.getAllByPlaceholderText(/9715XXXXXXXX/)[1];
    if (second === undefined) throw new Error("Second mobile input missing");
    // Empty is fine; an unconventional value is advisory only, never invalid.
    fireEvent.change(second, { target: { value: "123" } });
    expect(
      screen.getAllByText("Recommended UAE format: 0506468442 or 971506468442.").length,
    ).toBeGreaterThan(0);
    expect(second).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.change(second, { target: { value: "0506468442" } });
    expect(second).toHaveValue("0506468442");
  });

  it("shows the full breakdown in the detail card and only the headline totals in the footer", async () => {
    setup();
    await selectTraderAndCustomer();
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });
    await screen.findAllByText("AED 90.00");

    // The detailed card carries the full financial breakdown.
    expect(screen.getByText("Total Deductions")).toBeInTheDocument();
    // The headline totals are intentionally repeated in the sticky footer, so
    // each of these two appears exactly twice (detail card + footer).
    expect(screen.getAllByText("Amount due to Trader")).toHaveLength(2);
    expect(screen.getAllByText("Total amount to collect")).toHaveLength(2);
    // The de-duplicated footer does not repeat the deductions breakdown.
    const footer = document.querySelector(".order-totals");
    expect(footer?.textContent).not.toContain("Total Deductions");
    expect(footer?.textContent).toContain("Amount due to Trader");
    expect(footer?.textContent).toContain("Total amount to collect");
  });

  it("blocks creation when a Service Fee override has no reason", async () => {
    const { api } = setup();
    await selectTraderAndCustomer();
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });
    await screen.findAllByText("AED 90.00");

    fireEvent.click(screen.getByRole("checkbox", { name: "Override configured service fee" }));
    fireEvent.change(screen.getByLabelText("Overridden fee"), { target: { value: "15" } });
    // Reason deliberately left blank.
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    expect(
      await screen.findByRole("button", { name: "Enter a reason for the Service Fee override." }),
    ).toBeInTheDocument();
    // The Order must not be submitted while the override is incomplete.
    expect(api.post.mock.calls.filter(([path]) => path === "operations/orders")).toHaveLength(0);
  });

  it("offers recovery actions when the Trader has no configured price", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders/identifier-availability")) {
          return Promise.resolve({ referenceNumberAvailable: true, serialNumberAvailable: true });
        }
        if (path === "configuration/emirates") {
          return Promise.resolve([
            {
              code: "DXB",
              id: area.emirateId,
              nameAr: area.emirateNameAr,
              nameEn: area.emirateNameEn,
            },
          ]);
        }
        if (path.startsWith("configuration/customers/CUS-000001")) {
          return Promise.resolve({ addresses: [{ ...customer, isActive: true, isDefault: true }] });
        }
        const items = path.startsWith("operations/traders")
          ? [trader]
          : path.startsWith("configuration/customers")
            ? [customer]
            : [area];
        return Promise.resolve({ hasMore: false, items, total: 1 });
      }),
      post: vi.fn((path: string) => {
        if (path.endsWith("/quote")) {
          return Promise.reject(new ApiError("no price", "pricing_not_configured", 422));
        }
        return Promise.resolve({ orderNumber: "ORD-000300" });
      }),
    };
    render(
      <CreateOrderDialog
        api={api as unknown as ApiClient}
        drivers={[]}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        permissions={["users_roles.manage"]}
        searchDebounceMs={0}
      />,
    );
    await selectTraderAndCustomer();

    // The failure surfaces a clear message plus both recovery actions rather
    // than a silent dead end.
    expect(await screen.findByText(/could not be resolved/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Trader Pricing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Another Area" })).toBeInTheDocument();
  });

  it("creates a new Customer inline from typed Order details, with no separate modal", async () => {
    const { api, resolve } = setup();
    await selectTraderOnly();
    await typeNewCustomerAndArea("Mariam Buyer");
    const mobile = screen.getAllByPlaceholderText(/9715XXXXXXXX/)[0];
    if (mobile === undefined) throw new Error("Primary mobile input missing");
    fireEvent.change(mobile, { target: { value: "0506468442" } });
    fireEvent.change(screen.getByLabelText("Customer address"), {
      target: { value: "Villa 9, Dubai" },
    });
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });
    await screen.findAllByText("AED 90.00");

    // The fast flow has no Add Customer button and opens no modal.
    expect(screen.queryByRole("button", { name: /Add Customer/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    const creates = api.post.mock.calls.filter(([path]) => path === "operations/orders");
    expect(creates).toHaveLength(1);
    // Customer + Order go together via the atomic inline-customer payload, and
    // the mobile is carried exactly as typed.
    expect(creates[0]?.[1]).toMatchObject({
      customerId: undefined,
      customerMobileNumber: "0506468442",
      customerName: "Mariam Buyer",
      inlineCustomer: {
        address: "Villa 9, Dubai",
        areaId: area.id,
        mobileNumber: "0506468442",
        name: "Mariam Buyer",
      },
    });
    resolve({ orderNumber: "ORD-000400", serialNumber: "000123" });
  });

  it("keeps an empty Primary Mobile blocking even for a typed new Customer", async () => {
    setup();
    await selectTraderOnly();
    await typeNewCustomerAndArea("No Phone Buyer");
    fireEvent.change(screen.getByLabelText("Customer address"), { target: { value: "Somewhere" } });
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });
    // Mobile deliberately left empty.
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    expect(
      await screen.findByRole("button", { name: "Enter a mobile number." }),
    ).toBeInTheDocument();
  });

  it("maps a duplicate-Customer backend error to the Customer field and preserves values", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders/identifier-availability")) {
          return Promise.resolve({ referenceNumberAvailable: true, serialNumberAvailable: true });
        }
        if (path === "configuration/emirates") {
          return Promise.resolve([
            {
              code: "DXB",
              id: area.emirateId,
              nameAr: area.emirateNameAr,
              nameEn: area.emirateNameEn,
            },
          ]);
        }
        const items = path.startsWith("operations/traders")
          ? [trader]
          : path.startsWith("configuration/customers")
            ? [customer]
            : [area];
        return Promise.resolve({ hasMore: false, items, total: 1 });
      }),
      post: vi.fn((path: string) => {
        if (path.endsWith("/quote")) return Promise.resolve(quote);
        if (path === "configuration/areas") return Promise.resolve(area);
        return Promise.reject(new ApiError("dup", "customer_duplicate", 409));
      }),
    };
    render(
      <CreateOrderDialog
        api={api as unknown as ApiClient}
        drivers={[]}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        permissions={["users_roles.manage"]}
        searchDebounceMs={0}
      />,
    );
    await selectTraderOnly();
    await typeNewCustomerAndArea("Dup Buyer");
    const mobile = screen.getAllByPlaceholderText(/9715XXXXXXXX/)[0];
    if (mobile === undefined) throw new Error("Primary mobile input missing");
    fireEvent.change(mobile, { target: { value: "0506468442" } });
    fireEvent.change(screen.getByLabelText("Customer address"), { target: { value: "Villa 1" } });
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });
    await screen.findAllByText("AED 90.00");
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    // The duplicate message is mapped to the Customer field (and echoed in the
    // validation summary), not shown as an opaque banner.
    expect(
      (
        await screen.findAllByText(
          "A Customer with this mobile may already exist. Select the existing Customer or review the entered details.",
        )
      ).length,
    ).toBeGreaterThan(0);
    // Entered Order values are preserved after the failure.
    expect(screen.getByLabelText("COD amount")).toHaveValue(100);
    expect(mobile).toHaveValue("0506468442");
  });
});
