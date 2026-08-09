import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { i18nInstance } from "../localization/i18n.js";
import { FilterCombobox } from "./FilterCombobox.js";

/**
 * The Trader and Driver filters.
 *
 * They were plain `<select>`s labelled "TRD-000002 - Alam": an identifier the
 * operator does not think in, printed ahead of the name they do, on a list long
 * enough that finding a Trader meant scrolling it. Now the name alone is shown
 * and the list narrows as you type.
 *
 * The code is still MATCHED though never displayed -- someone who knows
 * "TRD-000002" can type it -- which is the part a plain relabelling would have
 * thrown away.
 */

const options = [
  { id: "t1", label: "Alam", searchText: "TRD-000002" },
  { id: "t2", label: "Abdul", searchText: "TRD-000001" },
  { id: "t3", label: "Noon", searchText: "TRD-000003" },
];

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <FilterCombobox
        emptyText="No Traders found"
        label="Trader"
        onChange={setValue}
        options={options}
        value={value}
      />
      <output>{value === "" ? "(none)" : value}</output>
    </>
  );
}

const box = () => screen.getByRole("combobox", { name: "Trader" }) as HTMLInputElement;

describe("FilterCombobox", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows the name without the code", () => {
    render(<Harness initial="t1" />);
    expect(box().value).toBe("Alam");
    expect(box().value).not.toContain("TRD-");
  });

  it("narrows the list as the operator types", async () => {
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "ab" } });

    await waitFor(() => expect(screen.getByRole("option", { name: "Abdul" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "Noon" })).toBeNull();
  });

  it("finds a Trader by a code that is never displayed", async () => {
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "TRD-000003" } });

    const match = await screen.findByRole("option", { name: "Noon" });
    // Matched on the code, listed by name.
    expect(match).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /TRD-000003/ })).toBeNull();
  });

  it("reports the identifier, not the label, when one is picked", async () => {
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "noon" } });
    fireEvent.click(await screen.findByRole("option", { name: "Noon" }));

    await waitFor(() => expect(screen.getByText("t3")).toBeInTheDocument());
    expect(box().value).toBe("Noon");
  });

  it("clears the filter through the All row", async () => {
    render(<Harness initial="t1" />);
    fireEvent.focus(box());
    fireEvent.click(await screen.findByRole("option", { name: "All Trader" }));

    await waitFor(() => expect(screen.getByText("(none)")).toBeInTheDocument());
    expect(box().value).toBe("");
  });

  it("offers the whole list again once a selection is made", async () => {
    // After picking "Noon" the box reads "Noon"; reopening must not filter the
    // list down to the one row that happens to match the text already shown.
    render(<Harness initial="t3" />);
    fireEvent.focus(box());

    await waitFor(() => expect(screen.getByRole("option", { name: "Alam" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "Abdul" })).toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "zzzz" } });

    expect(await screen.findByText("No Traders found")).toBeInTheDocument();
  });

  it("abandons a half-typed term on blur rather than leaving it in the box", async () => {
    render(<Harness initial="t1" />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "part" } });
    fireEvent.blur(box());

    // The filter never changed, so the box must go back to showing what IS
    // filtered -- not a term that was typed and never applied.
    await waitFor(() => expect(box().value).toBe("Alam"));
  });

  it("selects with the keyboard", async () => {
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "a" } });
    await screen.findByRole("option", { name: "Alam" });
    // Index 0 is the All row, so one press lands on the first Trader.
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });

    await waitFor(() => expect(screen.getByText("t1")).toBeInTheDocument());
  });
});
