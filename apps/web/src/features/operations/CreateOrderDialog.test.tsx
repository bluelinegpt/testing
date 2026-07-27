import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const traderOption = await screen.findByRole("option", { name: "TR-1 - Test Trader" });
  fireEvent.keyDown(traderInput, { key: "ArrowDown" });
  // Wait for the highlight to settle before Enter, then fire it synchronously
  // so no render can interleave. Guards the keyboard path against selecting
  // nothing when the option list is still settling under parallel test load.
  await waitFor(() => expect(traderOption).toHaveAttribute("aria-selected", "true"));
  fireEvent.keyDown(traderInput, { key: "Enter" });
  const customerInput = screen.getByPlaceholderText("Search by code, name, or mobile");
  fireEvent.focus(customerInput);
  fireEvent.change(customerInput, { target: { value: "CUS-000001" } });
  fireEvent.click(await screen.findByRole("option", { name: "CUS-000001 - Aisha - 971506468441" }));
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

  it("shows the selected Customer's name read-only, not as a second editable field", async () => {
    setup();
    // No customer chosen yet: the redundant name field is not rendered.
    expect(screen.queryByTestId("customer-name")).not.toBeInTheDocument();

    await selectTraderAndCustomer();

    // After selection the name is shown read-only and reflects the customer.
    const name = await screen.findByTestId("customer-name");
    expect(name).toHaveValue("Aisha");
    expect(name).toHaveAttribute("readonly");
  });

  it("searches by keyboard, validates UAE mobile, creates unassigned, and prevents duplicates", async () => {
    const { api, onSaved, resolve } = setup();
    await selectTraderAndCustomer();
    fireEvent.change(screen.getByTestId("customer-name"), { target: { value: "Aisha" } });
    const mobile = screen.getAllByPlaceholderText(/9715XXXXXXXX/)[0];
    if (mobile === undefined) throw new Error("Primary mobile input was not rendered");
    fireEvent.change(mobile, { target: { value: "0406468441" } });
    expect(
      screen.getByText("Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX."),
    ).toBeInTheDocument();
    // A local 05X number is accepted and normalized to the canonical form on submit.
    fireEvent.change(mobile, { target: { value: "0506468441" } });
    fireEvent.change(screen.getByLabelText("Customer address"), { target: { value: "Dubai" } });
    fireEvent.change(screen.getByLabelText("COD amount"), { target: { value: "100" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Create order" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    fireEvent.click(screen.getByRole("button", { name: /Working/ }));
    const creates = api.post.mock.calls.filter(([path]) => path === "operations/orders");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toMatchObject({
      additionalFees: 0,
      customerMobileNumber: "971506468441",
      driverId: undefined,
      referenceNumber: "REF-A1",
      serialNumber: "000123",
      serviceFee: undefined,
    });
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

    const create = screen.getByRole("button", { name: "Create order" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

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
    expect(await screen.findByText(/no configured price/i)).toBeInTheDocument();
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
    await screen.findByText(/no configured price/i);
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
