import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AccountingResourcePage } from "./AccountingResourcePage.js";

/**
 * Inline "+ Add Category" as it actually behaves inside the General Expense
 * create form, through the real `AccountingResourcePage` -- not just the
 * dialog and `RecordForm` in isolation (covered separately). This is the
 * first test `AccountingResourcePage` has ever had; it is scoped to the new
 * behaviour, not a general characterization suite for the whole component.
 */

const officeCategory = { code: "EXP-OFFICE", id: "cat-office", nameEn: "Office Supplies" };
const petrolCategory = { code: "EXP-PETROL-FUEL", id: "cat-petrol", nameEn: "Petrol / Fuel" };
const generalExpenseMapping = {
  expenseAccountCode: "5030",
  expenseAccountId: "acc-5030",
  isActive: true,
  mappingKey: "general_expense",
};
const glAccounts = [
  {
    accountType: "expense",
    id: "acc-5030",
    isActive: true,
    isPostingAccount: true,
    nameEn: "General Expense",
  },
];

function buildApi(options: { readonly categoriesAfterCreate?: readonly unknown[] } = {}) {
  let categories: readonly unknown[] = [officeCategory];
  const post = vi.fn((path: string) => {
    if (path === "operations/accounting/general-expenses/categories") {
      categories = options.categoriesAfterCreate ?? [officeCategory, petrolCategory];
      return Promise.resolve({ id: "cat-petrol" });
    }
    return Promise.resolve({});
  });
  const get = vi.fn((path: string) => {
    if (path.startsWith("operations/accounting/general-expenses/categories"))
      return Promise.resolve(categories);
    if (path === "operations/accounting/mappings") return Promise.resolve([generalExpenseMapping]);
    if (path === "operations/accounting/accounts") return Promise.resolve(glAccounts);
    if (path.startsWith("operations/accounting/general-expenses"))
      return Promise.resolve({ items: [], total: 0 });
    return Promise.resolve({});
  });
  return { api: { get, post } as unknown as ApiClient, post };
}

const renderPage = (permissions: readonly string[], api: ApiClient) =>
  render(
    <MemoryRouter>
      <AccountingResourcePage
        api={api}
        companyId="company-1"
        onNavigate={vi.fn()}
        permissions={permissions}
        section="expenses"
      />
    </MemoryRouter>,
  );

const openCreateForm = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  await screen.findByLabelText(/Quantity/, {}, { timeout: 3000 });
};

describe("General Expense create form — inline Add Category", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows + Add Category for a user who can manage Categories", async () => {
    const { api } = buildApi();
    renderPage(["accounting.manage"], api);
    await openCreateForm();
    expect(await screen.findByRole("button", { name: "+ Add Category" })).toBeInTheDocument();
  });

  /* There is no permission split for this feature to hide behind: creating a
     General Expense and managing Categories both require the SAME permission,
     `accounting.manage` (`definition.permission` for the "expenses" section).
     A `accounting.view`-only user cannot reach the create form at all, so
     "+ Add Category" is provably absent for them the same way everything
     else that needs `manage` is -- proven here by there being nothing to
     click into in the first place, never a leaked control elsewhere. */
  it("never renders + Add Category for a user without accounting.manage", async () => {
    const { api } = buildApi();
    renderPage(["accounting.view"], api);
    await screen.findByText("General Expenses");
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add Category" })).toBeNull();
  });

  it("opens the modal without leaving the General Expense screen", async () => {
    const { api } = buildApi();
    renderPage(["accounting.manage"], api);
    await openCreateForm();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add Category" }));
    expect(await screen.findByText("Create Expense Category")).toBeInTheDocument();
    // The General Expense form is still mounted underneath -- this is a
    // modal, not a navigation. Two "Create" buttons coexist once the form is
    // open (the page header's trigger and the form's own submit), so the
    // General Expense screen's own field is the more specific proof.
    expect(screen.getByLabelText(/Line description/)).toBeInTheDocument();
  });

  /* The requested placement is beside the TOP `categoryId` field only -- an
     earlier version of this feature attached it to `Line category ID`
     instead. This pins the correction: exactly one button in the whole form,
     living next to `categoryId`, never next to `Line category ID`. */
  it("places + Add Category beside the TOP categoryId field only, never beside Line category ID", async () => {
    const { api } = buildApi();
    renderPage(["accounting.manage"], api);
    await openCreateForm();

    expect(screen.getAllByRole("button", { name: "+ Add Category" })).toHaveLength(1);

    const categoryField = screen.getByLabelText("categoryId");
    expect(
      within(categoryField.parentElement!).getByRole("button", { name: "+ Add Category" }),
    ).toBeInTheDocument();

    const lineCategoryField = screen.getByLabelText(/Line category ID/);
    expect(
      within(lineCategoryField.parentElement!).queryByRole("button", { name: "+ Add Category" }),
    ).toBeNull();
  });

  it("creates a Category, auto-selects it, and preserves the rest of the form", async () => {
    const { api, post } = buildApi();
    renderPage(["accounting.manage"], api);
    await openCreateForm();

    // Fields entered BEFORE adding the Category.
    fireEvent.change(screen.getByLabelText(/^Payee/), { target: { value: "ADNOC Station" } });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "Fuel for Van 3" },
    });

    fireEvent.click(await screen.findByRole("button", { name: "+ Add Category" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/Category Name/), {
      target: { value: "Petrol / Fuel" },
    });
    await dialog.findByText("General Expense (5030)");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "operations/accounting/general-expenses/categories",
        expect.objectContaining({ nameEn: "Petrol / Fuel" }),
        expect.anything(),
      ),
    );
    // Modal closed, and the newly created Category is selected on the TOP
    // `categoryId` field the button sits beside -- not the separate,
    // independently-required `Line category ID` field, which the operator
    // still chooses on its own (see the architecture audit in the report).
    await waitFor(() => expect(screen.queryByText("Create Expense Category")).toBeNull());
    await waitFor(() => expect(screen.getByLabelText("categoryId")).toHaveValue("cat-petrol"));

    // Untouched fields, exactly as entered before the modal opened.
    expect(screen.getByLabelText(/^Payee/)).toHaveValue("ADNOC Station");
    expect(screen.getByLabelText(/^Description/)).toHaveValue("Fuel for Van 3");
  });

  it("Cancel closes the dialog and leaves the Category list unchanged", async () => {
    const { api, post } = buildApi();
    renderPage(["accounting.manage"], api);
    await openCreateForm();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add Category" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/Category Name/), { target: { value: "Petrol" } });

    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Create Expense Category")).toBeNull();
    expect(post).not.toHaveBeenCalled();
    // Existing Category selection is unaffected -- still just Office Supplies.
    const options = within(screen.getByLabelText(/Line category ID/)).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Select",
      "EXP-OFFICE — Office Supplies",
    ]);
  });

  it("leaves ordinary General Expense creation unaffected", async () => {
    const { api, post } = buildApi();
    renderPage(["accounting.manage"], api);
    await openCreateForm();
    fireEvent.change(screen.getByLabelText(/Line category ID/), {
      target: { value: "cat-office" },
    });
    fireEvent.change(screen.getByLabelText(/^Payee/), { target: { value: "Landlord" } });
    fireEvent.change(screen.getByLabelText(/Line description/), { target: { value: "Rent" } });
    fireEvent.change(screen.getByLabelText(/Quantity/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Unit amount/), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/VAT treatment/), {
      target: { value: "out_of_scope" },
    });
    fireEvent.change(screen.getByLabelText(/VAT rate/), { target: { value: "0" } });

    // Two "Create" buttons coexist once the form is open; the one that
    // actually submits is the form's own, type="submit".
    const submitCreate = screen
      .getAllByRole("button", { name: "Create" })
      .find((button) => button.getAttribute("type") === "submit")!;
    fireEvent.click(submitCreate);

    // `submitCreate` nests the line fields (including the Category) under
    // `lines[0]`; only header fields stay at the top level.
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "operations/accounting/general-expenses",
        expect.objectContaining({
          lines: [expect.objectContaining({ categoryId: "cat-office" })],
          payeeName: "Landlord",
        }),
        expect.anything(),
      ),
    );
  });
});
