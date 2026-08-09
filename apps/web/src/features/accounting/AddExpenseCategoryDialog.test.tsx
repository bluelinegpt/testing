import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { ApiError } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AddExpenseCategoryDialog } from "./AddExpenseCategoryDialog.js";
import type { AccountingApi } from "./accounting-api.js";

/**
 * Inline "+ Add Category" modal.
 *
 * These test the dialog in isolation, against a mocked `AccountingApi` --
 * the real endpoints it calls (`general-expenses/categories`, `mappings`,
 * `accounts`) are covered on the API side by the existing General Expense
 * suites, unchanged by this feature.
 */

const existingCategory = {
  code: "EXP-OFFICE",
  defaultExpenseMappingKey: "general_expense",
  id: "cat-office",
  nameEn: "Office Supplies",
};

const generalExpenseMapping = {
  expenseAccountCode: "5030",
  expenseAccountId: "acc-5030",
  isActive: true,
  mappingKey: "general_expense",
};

// A mapping key belonging to another subsystem (Outsourced Driver fees) --
// also active, also an expense account, but never vetted for a General
// Expense Category. Present in the fixture specifically to prove it is
// excluded.
const reservedMapping = {
  expenseAccountCode: "5010",
  expenseAccountId: "acc-5010",
  isActive: true,
  mappingKey: "outsourced_driver_fee_expense",
};

const accounts = [
  {
    accountType: "expense",
    id: "acc-5030",
    isActive: true,
    isPostingAccount: true,
    nameEn: "General Expense",
  },
  {
    accountType: "expense",
    id: "acc-5010",
    isActive: true,
    isPostingAccount: true,
    nameEn: "Outsourced Driver Fee Expense",
  },
];

function buildClient(
  overrides: {
    readonly mappings?: readonly unknown[];
    readonly categories?: readonly unknown[];
    readonly post?: (path: string, body?: unknown) => Promise<unknown>;
  } = {},
) {
  const post = vi.fn(overrides.post ?? (() => Promise.resolve({ id: "new-cat" })));
  const get = vi.fn((path: string) => {
    if (path === "general-expenses/categories")
      return Promise.resolve(overrides.categories ?? [existingCategory]);
    if (path === "mappings")
      return Promise.resolve(overrides.mappings ?? [generalExpenseMapping, reservedMapping]);
    return Promise.resolve([]);
  });
  const accountsFn = vi.fn(() => Promise.resolve(accounts));
  return {
    client: { accounts: accountsFn, get, post } as unknown as AccountingApi,
    get,
    post,
  };
}

const renderDialog = (client: AccountingApi, onCreated = vi.fn(), onClose = vi.fn()) => {
  render(
    <AddExpenseCategoryDialog
      client={client}
      companyId="company-1"
      language="en"
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { onClose, onCreated };
};

describe("AddExpenseCategoryDialog", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("offers only mapping keys already vetted for a Category, never a subsystem-reserved one", async () => {
    const { client } = buildClient();
    renderDialog(client);
    await screen.findByText("General Expense (5030)");
    expect(screen.queryByText(/Outsourced Driver Fee Expense/)).toBeNull();
  });

  it("requires a Category Name", async () => {
    const { client } = buildClient();
    renderDialog(client);
    await screen.findByText("General Expense (5030)");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a Category Name.")).toBeInTheDocument();
  });

  it("requires a Linked GL Expense Account when none is eligible", async () => {
    const { client } = buildClient({ mappings: [] });
    renderDialog(client);
    await screen.findByText(
      "No active Expense GL Account is configured yet. Ask an Accounting administrator to add one before creating a Category.",
    );
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });
    // Disabled, matching there being nothing valid to submit against.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("auto-suggests a Code from the Name and keeps it editable", async () => {
    const { client } = buildClient();
    renderDialog(client);
    await screen.findByText("General Expense (5030)");
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/Category Code/)).toHaveValue("EXP-PETROL-FUEL"),
    );

    fireEvent.change(screen.getByLabelText(/Category Code/), { target: { value: "EXP-FUEL" } });
    // Editing the Code stops it from being silently overwritten as the Name
    // keeps changing.
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel " },
    });
    expect(screen.getByLabelText(/Category Code/)).toHaveValue("EXP-FUEL");
  });

  it("avoids a Code collision with an existing Category", async () => {
    const { client } = buildClient({
      categories: [
        existingCategory,
        { code: "EXP-PETROL-FUEL", id: "cat-2", nameEn: "Fuel (old)" },
      ],
    });
    renderDialog(client);
    await screen.findByText("General Expense (5030)");
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/Category Code/)).toHaveValue("EXP-PETROL-FUEL-2"),
    );
  });

  it("creates the Category under the authenticated Company and reports it back", async () => {
    const { client, post } = buildClient();
    const { onCreated } = renderDialog(client);
    await screen.findByText("General Expense (5030)");
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/Category Code/)).toHaveValue("EXP-PETROL-FUEL"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "general-expenses/categories",
        expect.objectContaining({
          code: "EXP-PETROL-FUEL",
          defaultExpenseMappingKey: "general_expense",
          nameEn: "Petrol / Fuel",
        }),
      ),
    );
    // No explicit companyId in the payload -- the server derives it from the
    // authenticated session, exactly like every other Accounting mutation.
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty("companyId");
    expect(onCreated).toHaveBeenCalledWith({ id: "new-cat", nameEn: "Petrol / Fuel" });
  });

  it("closes without creating anything on Cancel", async () => {
    const { client, post } = buildClient();
    const { onClose } = renderDialog(client);
    await screen.findByText("General Expense (5030)");
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate-code rejection as a field-level, user-friendly error", async () => {
    const { client } = buildClient({
      post: () => Promise.reject(new ApiError("Category code already exists", "conflict", 409)),
    });
    renderDialog(client);
    await screen.findByText("General Expense (5030)");
    fireEvent.change(screen.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/Category Code/)).toHaveValue("EXP-PETROL-FUEL"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Category code already exists")).toBeInTheDocument();
  });

  it("renders in Arabic with RTL applied to the Arabic Name field", async () => {
    await i18nInstance.changeLanguage("ar");
    const { client } = buildClient();
    render(
      <AddExpenseCategoryDialog
        client={client}
        companyId="company-1"
        language="ar"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    expect(await screen.findByText("إنشاء فئة مصروفات")).toBeInTheDocument();
    expect(screen.getByText("اسم الفئة")).toBeInTheDocument();
    expect(screen.getByLabelText("الاسم بالعربية")).toHaveAttribute("dir", "rtl");
  });
});
