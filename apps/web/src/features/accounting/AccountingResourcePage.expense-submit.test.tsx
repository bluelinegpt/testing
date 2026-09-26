import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AccountingResourcePage } from "./AccountingResourcePage.js";

/**
 * Submitting and Approving a General Expense.
 *
 * Neither has a dedicated reason column to fill -- only Reject's and
 * Cancel's reasons are persisted (`rejection_reason`/`cancellation_reason` in
 * `general-expense.service.ts`); Approve's own `reason(input.reason)` call
 * only ever lands in the accounting event's `metadata.reason`, and Submit's
 * is audit-log-only. Forcing a typed Reason before either added friction with
 * no business payoff, so neither requires one anymore -- matching the
 * existing convention Journal's own `approve`/`post`/`validate` actions
 * already used.
 */

const draftExpense = {
  expenseNumber: "EXP-1",
  id: "exp-1",
  status: "draft",
  totalAmount: "100.00",
  version: 1,
};
const submittedExpense = { ...draftExpense, status: "submitted" };

function buildApi(record: typeof draftExpense = draftExpense) {
  const post = vi.fn(() => Promise.resolve({}));
  const get = vi.fn((path: string) => {
    if (path === "operations/accounting/general-expenses/exp-1") {
      return Promise.resolve(record);
    }
    if (path.startsWith("operations/accounting/general-expenses/exp-1/accounting-preview")) {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  return { api: { get, post } as unknown as ApiClient, post };
}

const renderDetail = (api: ApiClient, permissions: readonly string[] = ["accounting.manage"]) =>
  render(
    <MemoryRouter>
      <AccountingResourcePage
        api={api}
        companyId="company-1"
        id="exp-1"
        onNavigate={vi.fn()}
        permissions={permissions}
        section="expenses"
      />
    </MemoryRouter>,
  );

describe("Submitting a draft General Expense", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("does not show a Reason field on the Submit confirmation", async () => {
    const { api } = buildApi();
    renderDetail(api);

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    await screen.findByRole("dialog");

    expect(screen.queryByText("Reason")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /reason/i })).toBeNull();
  });

  it("confirms Submit without requiring any input, sending a default reason to the backend", async () => {
    const { api, post } = buildApi();
    renderDetail(api);

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "operations/accounting/general-expenses/exp-1/submit",
        expect.objectContaining({
          reason: "Confirmed by the authorized user",
          version: 1,
        }),
        expect.anything(),
      ),
    );
  });
});

describe("Approving a submitted General Expense", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("does not show a Reason field on the Approve confirmation", async () => {
    const { api } = buildApi(submittedExpense);
    renderDetail(api, ["accounting.manage", "accounting.approve"]);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByRole("dialog");

    expect(screen.queryByText("Reason")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /reason/i })).toBeNull();
  });

  it("confirms Approve without requiring any input, sending a default reason to the backend", async () => {
    const { api, post } = buildApi(submittedExpense);
    renderDetail(api, ["accounting.manage", "accounting.approve"]);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "operations/accounting/general-expenses/exp-1/approve",
        expect.objectContaining({
          reason: "Confirmed by the authorized user",
          version: 1,
        }),
        expect.anything(),
      ),
    );
  });
});
