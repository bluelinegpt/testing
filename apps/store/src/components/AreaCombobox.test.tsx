import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";

import { storeI18n } from "../localization/i18n.js";

import { AreaCombobox } from "./AreaCombobox.js";

/**
 * Pre-production fix: the searchable Area combobox.
 *
 * `searchAreas` is mocked at the module boundary -- these tests are about the
 * combobox's own contract (search-as-you-type, keyboard selection, never
 * submitting unconfirmed text, resetting on Emirate change), not the network
 * layer already covered by `commerce-checkout.database.test.ts`.
 */
vi.mock("../api/checkout-client.js", () => ({
  searchAreas: vi.fn(),
}));

import { searchAreas } from "../api/checkout-client.js";

const alAlia = { code: "AB", emirateId: "e1", id: "a1", nameAr: "العالية", nameEn: "Al Alia" };
const alJurf = { code: "AJ", emirateId: "e1", id: "a2", nameAr: "الجرف", nameEn: "Al Jurf" };

function renderCombobox(props: Partial<Parameters<typeof AreaCombobox>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <I18nextProvider i18n={storeI18n}>
      <AreaCombobox
        emirateId="e1"
        onChange={onChange}
        storeSlug="ajman-store"
        value={null}
        {...props}
      />
    </I18nextProvider>,
  );
  return { onChange, rerender: result.rerender };
}

beforeEach(() => {
  vi.mocked(searchAreas).mockResolvedValue({ hasMore: false, items: [alAlia, alJurf] });
});

describe("AreaCombobox", () => {
  it("is disabled until an Emirate is chosen", () => {
    renderCombobox({ emirateId: undefined });
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("searches and lists matching Areas as the customer types", async () => {
    renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Al" } });
    await waitFor(() =>
      expect(searchAreas).toHaveBeenCalledWith({
        emirateId: "e1",
        search: "Al",
        storeSlug: "ajman-store",
      }),
    );
    await waitFor(() => expect(screen.getByText("Al Alia")).toBeInTheDocument());
    expect(screen.getByText("Al Jurf")).toBeInTheDocument();
  });

  it("commits a selection on click and reports the full Area object, never free text", async () => {
    const { onChange } = renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Al" } });
    await waitFor(() => expect(screen.getByText("Al Alia")).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByText("Al Alia"));
    expect(onChange).toHaveBeenLastCalledWith(alAlia);
    expect(input).toHaveValue("Al Alia");
  });

  it("supports ArrowDown + Enter keyboard selection", async () => {
    const { onChange } = renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Al" } });
    await waitFor(() => expect(screen.getByText("Al Alia")).toBeInTheDocument());
    // The first result is highlighted by default -- ArrowDown moves to the
    // second, and Enter selects whichever is currently highlighted.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(alJurf);
  });

  it("reverts to the last real selection on blur if nothing was actually chosen", async () => {
    const { onChange } = renderCombobox({ value: alAlia });
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("Al Alia");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "typed but never selected" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue("Al Alia"));
    // Typing invalidated the prior commit exactly once; blur never re-commits it.
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ nameEn: "typed but never selected" }),
    );
  });

  it("resets the selection when the Emirate changes", () => {
    const { onChange, rerender } = renderCombobox({ value: alAlia });
    onChange.mockClear();
    rerender(
      <I18nextProvider i18n={storeI18n}>
        <AreaCombobox emirateId="e2" onChange={onChange} storeSlug="ajman-store" value={alAlia} />
      </I18nextProvider>,
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows Arabic Area names when the active language is Arabic", async () => {
    void storeI18n.changeLanguage("ar");
    renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ا" } });
    await waitFor(() => expect(screen.getByText("العالية")).toBeInTheDocument());
    await storeI18n.changeLanguage("en");
  });
});
