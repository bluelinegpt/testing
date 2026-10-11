import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AccountingResourcePage } from "./AccountingResourcePage.js";

/**
 * The Bank account create form follows the Company's GL Accounting mode,
 * exactly as the Cash account form does.
 *
 *   - Accounting OFF: no GL account required; operational note; the form
 *     submits `linkedGlAccountId: null`.
 *   - Accounting ON: unchanged -- the GL account is required.
 *   - Mode not yet known (or unreadable): treated as ON, never relaxed.
 *
 * The API enforces the same rule (it refuses a GL-less bank account for an ON
 * Company); this suite pins the UI half.
 */

const bankGlAccount = {
  accountClass: "bank",
  accountType: "asset",
  code: "1020",
  id: "acc-1020",
  isActive: true,
  isPostingAccount: true,
  nameEn: "Bank",
};

function buildApi(configuration: () => Promise<unknown>) {
  const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({ id: "bank-1" }),
  );
  const get = vi.fn((path: string) => {
    if (path === "operations/accounting/configuration") return configuration();
    if (path.startsWith("operations/accounting/accounts")) return Promise.resolve([bankGlAccount]);
    if (path.startsWith("operations/accounting/cash-bank/bank-accounts"))
      return Promise.resolve({ items: [], total: 0 });
    return Promise.resolve({});
  });
  return { api: { get, post } as unknown as ApiClient, get, post };
}

const renderPage = (api: ApiClient) =>
  render(
    <MemoryRouter>
      <AccountingResourcePage
        api={api}
        companyId="company-1"
        onNavigate={vi.fn()}
        permissions={["accounting.view", "accounting.configuration.manage"]}
        section="bank-accounts"
      />
    </MemoryRouter>,
  );

const glNote = /an active Bank account without a GL account blocks enabling/;

async function openCreateForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  return waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("input[name='linkedGlAccountId']");
    expect(input).not.toBeNull();
    return input!.parentElement!.querySelector<HTMLInputElement>("input[type='search']")!;
  });
}

describe("Bank account form and GL Accounting mode", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("Accounting OFF: GL account optional, with the operational note", async () => {
    const { api } = buildApi(() => Promise.resolve({ accountingEnabled: false }));
    renderPage(api);
    const glInput = await openCreateForm();
    expect(await screen.findByText(glNote)).toBeInTheDocument();
    await waitFor(() => expect(glInput.required).toBe(false));
  });

  it("Accounting OFF: submits without a GL account (linkedGlAccountId null)", async () => {
    const { api, post } = buildApi(() => Promise.resolve({ accountingEnabled: false }));
    const { container } = renderPage(api);
    await openCreateForm();
    await screen.findByText(glNote);
    const field = (name: string) =>
      container.querySelector<HTMLInputElement | HTMLSelectElement>(
        `form [name='${name}'], form #${name}`,
      );
    const byLabel = (name: string) => {
      const hidden = field(name);
      if (hidden !== null && hidden.getAttribute("type") !== "hidden") return hidden;
      return null;
    };
    const fill = (name: string, value: string) => {
      const element =
        byLabel(name) ??
        Array.from(
          container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
            "form input, form select",
          ),
        ).find((candidate) => candidate.id.endsWith(`-${name}`))!;
      fireEvent.change(element, { target: { value } });
    };
    fill("code", "BANK-MAIN");
    fill("accountName", "Operating account");
    fill("bankName", "Emirates Bank");
    fill("accountType", "current");
    fill("effectiveFrom", "2026-10-01");
    const submit = screen
      .getAllByRole("button", { name: "Create" })
      .find((button) => button.getAttribute("type") === "submit")!;
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("operations/accounting/cash-bank/bank-accounts");
    expect(body).toMatchObject({ code: "BANK-MAIN", linkedGlAccountId: null });
  });

  it("Accounting ON: GL account stays required and no OFF note is shown", async () => {
    const { api } = buildApi(() => Promise.resolve({ accountingEnabled: true }));
    renderPage(api);
    const glInput = await openCreateForm();
    await waitFor(() => expect(glInput.required).toBe(true));
    expect(screen.queryByText(glNote)).toBeNull();
  });

  it("mode unknown (configuration unreadable): treated as ON, GL required", async () => {
    const { api } = buildApi(() => Promise.reject(new Error("unavailable")));
    renderPage(api);
    const glInput = await openCreateForm();
    await waitFor(() => expect(glInput.required).toBe(true));
    expect(screen.queryByText(glNote)).toBeNull();
  });
});
