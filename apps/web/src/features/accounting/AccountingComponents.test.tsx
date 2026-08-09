import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { AccountingTable, RecordForm, SummaryCards } from "./AccountingComponents.js";
import type { FieldDefinition } from "./accounting-types.js";

/**
 * Summary tiles render one scalar each.
 *
 * The Accounting Events screen showed a tile labelled "items" reading
 * "[object Object],[object Object],…" because its summary endpoint returns a
 * breakdown array rather than the flat map every other summary endpoint
 * returns, and the tile stringified it. The guard belongs here because this is
 * the one component every summary tile renders through.
 */
describe("SummaryCards", () => {
  it("renders scalar values as text", () => {
    render(<SummaryCards items={[{ label: "Expenses", value: "100.00" }]} />);
    expect(screen.getByText("100.00")).toBeInTheDocument();
  });

  it("never stringifies an array into the tile", () => {
    render(<SummaryCards items={[{ label: "items", value: [{ area: "orders", count: 9 }] }]} />);
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("never stringifies an object into the tile", () => {
    render(<SummaryCards items={[{ label: "coverage", value: { missing: 4 } }]} />);
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("shows the em dash for a missing value rather than 'undefined'", () => {
    render(<SummaryCards items={[{ label: "Outstanding", value: undefined }]} />);
    expect(screen.queryByText("undefined")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

/**
 * A table row that opens a record is an interactive control.
 *
 * The row carried an onClick handler but no role, no tabindex and no key
 * handler, so an Accounting Event could not be opened without a mouse — and
 * the Event detail is the only route to Reprocess. Screen readers were given
 * no indication the row did anything at all.
 */
describe("AccountingTable clickable rows", () => {
  const columns = [{ key: "reference", label: "Reference" }];
  const items = [{ id: "row-1", reference: "EVT-1" }];

  it("exposes an openable row as a focusable button", () => {
    render(
      <AccountingTable columns={columns} empty="none" items={items} onOpen={() => undefined} />,
    );
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("opens the row on Enter and on Space", () => {
    const opened: unknown[] = [];
    render(
      <AccountingTable
        columns={columns}
        empty="none"
        items={items}
        onOpen={(row) => opened.push(row)}
      />,
    );
    const row = screen.getByRole("button");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(opened).toHaveLength(2);
  });

  it("ignores other keys so typing in a row control does not open it", () => {
    const opened: unknown[] = [];
    render(
      <AccountingTable
        columns={columns}
        empty="none"
        items={items}
        onOpen={(row) => opened.push(row)}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "a" });
    expect(opened).toHaveLength(0);
  });

  it("leaves a non-openable row as a plain row", () => {
    render(<AccountingTable columns={columns} empty="none" items={items} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

/**
 * `RecordForm`'s `trailingAction` and `patch` -- the two extension points the
 * inline "+ Add Category" flow depends on.
 *
 * `patch` exists specifically because `RecordForm` owns its field values
 * internally: a Category created through the trailing action has to land in
 * an already-open form (Payee, Amount, Notes already typed) without any of
 * that being reset, which ruled out remounting or a `key` change.
 */
describe("RecordForm", () => {
  const categoryField: FieldDefinition = {
    name: "categoryId",
    options: [{ label: "Office Supplies", value: "cat-office" }],
    type: "select",
  };

  it("renders a select's trailingAction beside it", () => {
    const onClick = vi.fn();
    render(
      <RecordForm
        fields={[{ ...categoryField, trailingAction: { label: "+ Add Category", onClick } }]}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Create"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Add Category" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("omits the trailingAction entirely when the field defines none", () => {
    render(
      <RecordForm
        fields={[categoryField]}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Create"
      />,
    );
    expect(screen.queryByRole("button", { name: /Add/ })).toBeNull();
  });

  // Labels below use the field's raw NAME rather than a translated string:
  // this file never initializes i18n (unlike AddExpenseCategoryDialog's own
  // suite), so `t()` falls back to `field.name` verbatim -- which is exactly
  // what RecordForm itself does when a key has no translation.
  it("patch sets one field without disturbing another the operator already typed", () => {
    const fields: readonly FieldDefinition[] = [categoryField, { name: "payeeName", type: "text" }];
    const { rerender } = render(
      <RecordForm fields={fields} onCancel={vi.fn()} onSubmit={vi.fn()} submitLabel="Create" />,
    );
    fireEvent.change(screen.getByLabelText("payeeName"), { target: { value: "ADNOC" } });

    rerender(
      <RecordForm
        fields={fields}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        patch={[{ name: "categoryId", value: "cat-office" }]}
        submitLabel="Create"
      />,
    );

    expect(screen.getByLabelText("categoryId")).toHaveValue("cat-office");
    // The whole point: payeeName is exactly what was typed before the patch.
    expect(screen.getByLabelText("payeeName")).toHaveValue("ADNOC");
  });

  it("patch sets multiple fields from one array in a single pass", () => {
    const fields: readonly FieldDefinition[] = [
      categoryField,
      {
        name: "lineCategoryId",
        options: [{ label: "Office Supplies", value: "cat-office" }],
        type: "select",
      },
    ];
    render(
      <RecordForm
        fields={fields}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        patch={[
          { name: "categoryId", value: "cat-office" },
          { name: "lineCategoryId", value: "cat-office" },
        ]}
        submitLabel="Create"
      />,
    );
    expect(screen.getByLabelText("categoryId")).toHaveValue("cat-office");
    expect(screen.getByLabelText("lineCategoryId")).toHaveValue("cat-office");
  });
});
