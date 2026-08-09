import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyArea } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";

import { AreaSelector } from "./AreaSelector.js";

const dubaiId = "50000000-0000-4000-8000-000000000001";
const sharjahId = "50000000-0000-4000-8000-000000000002";

const emirates = [
  { code: "DXB", id: dubaiId, nameAr: "دبي", nameEn: "Dubai" },
  { code: "SHJ", id: sharjahId, nameAr: "الشارقة", nameEn: "Sharjah" },
];

function area(overrides: Partial<CompanyArea> = {}): CompanyArea {
  return {
    code: "AREA-000001",
    emirateCode: "DXB",
    emirateId: dubaiId,
    emirateNameAr: "دبي",
    emirateNameEn: "Dubai",
    id: "60000000-0000-4000-8000-000000000001",
    isActive: true,
    nameAr: "جميرا",
    nameEn: "Jumeirah",
    notes: null,
    updatedAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  };
}

const jumeirah = area();
const sharjahArea = area({
  emirateCode: "SHJ",
  emirateId: sharjahId,
  emirateNameEn: "Sharjah",
  id: "60000000-0000-4000-8000-000000000002",
  nameEn: "Al Nahda",
});

/** Wraps the selector in parent state, as every real caller does. */
function Harness({
  api,
  includeDisabled,
  onChange,
}: {
  api: ApiClient;
  includeDisabled?: boolean;
  onChange?: (value: CompanyArea | undefined) => void;
}) {
  const [selected, setSelected] = useState<CompanyArea | undefined>();
  const [parentField, setParentField] = useState("");
  return (
    <form>
      {/* Proves the parent's own state survives inline Area creation. */}
      <label>
        <span>Address</span>
        <input onChange={(event) => setParentField(event.target.value)} value={parentField} />
      </label>
      <AreaSelector
        api={api}
        {...(includeDisabled === undefined ? {} : { includeDisabled })}
        onChange={(value) => {
          setSelected(value);
          onChange?.(value);
        }}
        searchDebounceMs={0}
        value={selected}
      />
    </form>
  );
}

function createApi(areas: readonly CompanyArea[] = [jumeirah, sharjahArea]) {
  const get = vi.fn((path: string) => {
    if (path === "configuration/emirates") return Promise.resolve(emirates);
    if (path.startsWith("configuration/areas/search")) {
      const emirateId = /emirateId=([^&]*)/.exec(path)?.[1] ?? "";
      const activeOnly = /activeOnly=([^&]*)/.exec(path)?.[1] === "true";
      const search = decodeURIComponent(/[?&]search=([^&]*)/.exec(path)?.[1] ?? "");
      const items = areas
        .filter((item) => item.emirateId === decodeURIComponent(emirateId))
        .filter((item) => !activeOnly || item.isActive)
        .filter(
          (item) => search === "" || item.nameEn.toLowerCase().includes(search.toLowerCase()),
        );
      return Promise.resolve({ hasMore: false, items, total: items.length });
    }
    return Promise.resolve({ hasMore: false, items: [], total: 0 });
  });
  return { get, patch: vi.fn(), post: vi.fn() };
}

describe("AreaSelector", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("requires the Emirate first and disables inline Add until one is chosen", async () => {
    const api = createApi();
    render(<Harness api={api as unknown as ApiClient} />);
    await screen.findByRole("option", { name: "Dubai" });

    expect(screen.getByPlaceholderText("Select an Emirate first")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Area" })).toBeDisabled();
    // No Area search happens before an Emirate narrows it.
    expect(api.get).not.toHaveBeenCalledWith(
      expect.stringContaining("configuration/areas/search"),
      expect.anything(),
    );
  });

  it("filters Areas by the selected Emirate and searches within it", async () => {
    const api = createApi();
    render(<Harness api={api as unknown as ApiClient} />);
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    const input = await screen.findByPlaceholderText("Search by Area name or code");
    fireEvent.focus(input);

    // Dubai's Area is offered; Sharjah's is not.
    expect(await screen.findByRole("option", { name: "Jumeirah" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Al Nahda" })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Jum" } });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringContaining("search=Jum"),
        expect.anything(),
      ),
    );
  });

  it("clears a selected Area when the Emirate changes", async () => {
    const api = createApi();
    const onChange = vi.fn();
    render(<Harness api={api as unknown as ApiClient} onChange={onChange} />);
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    const input = await screen.findByPlaceholderText("Search by Area name or code");
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: "Jumeirah" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(jumeirah));

    // Switching Emirate must not leave an Area that contradicts it.
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: sharjahId } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("offers only active Areas for new operational records", async () => {
    const disabled = area({ id: "disabled-1", isActive: false, nameEn: "Retired Area" });
    const api = createApi([jumeirah, disabled]);
    render(<Harness api={api as unknown as ApiClient} />);
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    fireEvent.focus(await screen.findByPlaceholderText("Search by Area name or code"));

    expect(await screen.findByRole("option", { name: "Jumeirah" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Retired Area" })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining("activeOnly=true"),
      expect.anything(),
    );
  });

  it("still resolves a disabled Area in a historical edit context", async () => {
    const disabled = area({ id: "disabled-1", isActive: false, nameEn: "Retired Area" });
    const api = createApi([disabled]);
    render(<Harness api={api as unknown as ApiClient} includeDisabled />);
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    fireEvent.focus(await screen.findByPlaceholderText("Search by Area name or code"));

    expect(await screen.findByRole("option", { name: "Retired Area" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining("activeOnly=false"),
      expect.anything(),
    );
  });

  it("shows the empty state when the Emirate has no Areas", async () => {
    const api = createApi([]);
    render(<Harness api={api as unknown as ApiClient} />);
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    fireEvent.focus(await screen.findByPlaceholderText("Search by Area name or code"));

    expect(await screen.findByText("No Areas found")).toBeInTheDocument();
  });

  it("surfaces an error when the Emirate master cannot be loaded", async () => {
    const api = {
      get: vi.fn().mockRejectedValue(new Error("offline")),
      patch: vi.fn(),
      post: vi.fn(),
    };
    render(<Harness api={api as unknown as ApiClient} />);

    expect(await screen.findByText("Emirates could not be loaded.")).toBeInTheDocument();
  });

  it("creates an Area inline, selects it, and preserves the parent form", async () => {
    const created = area({ id: "new-area", nameEn: "Al Barsha" });
    const api = createApi();
    api.post = vi.fn().mockResolvedValue(created);
    const onChange = vi.fn();
    render(<Harness api={api as unknown as ApiClient} onChange={onChange} />);
    await screen.findByRole("option", { name: "Dubai" });

    // Type into the parent form first; it must survive the nested modal.
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Villa 12" } });
    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });

    fireEvent.click(screen.getByRole("button", { name: "Add Area" }));

    // The shared authoritative form opens with the Emirate prefilled. Scope to
    // the dialog: the selector behind it also renders an Emirate field.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Emirate")).toHaveValue(dubaiId);
    fireEvent.change(within(dialog).getByLabelText("Area Name"), {
      target: { value: "Al Barsha" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(created));
    // The Emirate was prefilled from the selector, not re-chosen by the user.
    expect(api.post).toHaveBeenCalledWith("configuration/areas", {
      emirateId: dubaiId,
      nameAr: "",
      nameEn: "Al Barsha",
      notes: "",
    });
    // The parent's own field is untouched.
    expect(screen.getByLabelText("Address")).toHaveValue("Villa 12");
  });

  it("renders Emirate and Area labels in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    const api = createApi();
    render(<Harness api={api as unknown as ApiClient} />);

    expect(await screen.findByRole("option", { name: "دبي" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("الإمارة"), { target: { value: dubaiId } });
    fireEvent.focus(await screen.findByPlaceholderText("ابحث باسم المنطقة أو رمزها"));
    // The Arabic Area name is preferred when present.
    expect(await screen.findByRole("option", { name: "جميرا" })).toBeInTheDocument();
    await i18nInstance.changeLanguage("en");
  });
});
