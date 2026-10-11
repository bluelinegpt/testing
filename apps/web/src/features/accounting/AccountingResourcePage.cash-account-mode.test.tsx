import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AccountingResourcePage } from "./AccountingResourcePage.js";

/**
 * The Cash account create form follows the Company's GL Accounting mode.
 *
 *   - Accounting OFF: a drawer needs no GL account. The field is optional, an
 *     operational note explains why (and that one is needed before enabling
 *     GL Accounting), and the form submits `linkedGlAccountId: null`.
 *   - Accounting ON: unchanged -- the GL account is required.
 *   - Mode not yet known (or unreadable): treated as ON, never relaxed.
 *
 * The API enforces the same rule independently (it refuses a GL-less drawer
 * for an ON Company); this suite pins the UI half.
 */

const cashGlAccount = {
  accountType: "asset",
  code: "1010",
  id: "acc-1010",
  isActive: true,
  isPostingAccount: true,
  nameEn: "Cash on hand",
};

function buildApi(configuration: () => Promise<unknown>) {
  const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({ id: "cash-1" }),
  );
  const get = vi.fn((path: string) => {
    if (path === "operations/accounting/configuration") return configuration();
    if (path.startsWith("operations/accounting/accounts")) return Promise.resolve([cashGlAccount]);
    if (path.startsWith("operations/accounting/cash-bank/cash-accounts"))
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
        section="cash-accounts"
      />
    </MemoryRouter>,
  );

const glNote = /GL Accounting is OFF for this Company, so a GL account is optional/;

async function openCreateForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  return waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("input[name='linkedGlAccountId']");
    expect(input).not.toBeNull();
    return input!.parentElement!.querySelector<HTMLInputElement>("input[type='search']")!;
  });
}

describe("Cash account form and GL Accounting mode", () => {
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
    fill("code", "CASH-MAIN");
    fill("name", "Main drawer");
    fill("type", "main_cash");
    fill("effectiveFrom", "2026-10-01");
    const submit = screen
      .getAllByRole("button", { name: "Create" })
      .find((button) => button.getAttribute("type") === "submit")!;
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("operations/accounting/cash-bank/cash-accounts");
    expect(body).toMatchObject({ code: "CASH-MAIN", linkedGlAccountId: null });
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
