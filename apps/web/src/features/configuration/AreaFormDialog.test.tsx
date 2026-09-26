import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyArea } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";

import { AreaFormDialog } from "./AreaFormDialog.js";

const dubaiId = "50000000-0000-4000-8000-000000000001";
const sharjahId = "50000000-0000-4000-8000-000000000002";

const emirates = [
  { code: "DXB", id: dubaiId, nameAr: "دبي", nameEn: "Dubai" },
  { code: "SHJ", id: sharjahId, nameAr: "الشارقة", nameEn: "Sharjah" },
];

const savedArea: CompanyArea = {
  code: "AREA-000001",
  emirateCode: "DXB",
  emirateId: dubaiId,
  emirateNameAr: "دبي",
  emirateNameEn: "Dubai",
  id: "60000000-0000-4000-8000-000000000001",
  isActive: true,
  nameAr: null,
  nameEn: "Jumeirah",
  notes: null,
  updatedAt: "2026-07-19T10:00:00.000Z",
};

function createApi(overrides: Partial<Record<"patch" | "post", unknown>> = {}) {
  return {
    get: vi.fn().mockResolvedValue(emirates),
    patch: overrides.patch ?? vi.fn().mockResolvedValue(savedArea),
    post: overrides.post ?? vi.fn().mockResolvedValue(savedArea),
  };
}

describe("AreaFormDialog", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("requires an Emirate and a name before submitting", async () => {
    const api = createApi();
    render(
      <AreaFormDialog api={api as unknown as ApiClient} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Select an Emirate.")).toBeInTheDocument();
    expect(screen.getByText("Area Name is required.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name without calling the API", async () => {
    const api = createApi();
    render(
      <AreaFormDialog api={api as unknown as ApiClient} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    fireEvent.change(screen.getByLabelText("Area Name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Area Name is required.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("creates an Area with a trimmed name and no client-supplied code", async () => {
    const api = createApi();
    const onSaved = vi.fn();
    render(
      <AreaFormDialog api={api as unknown as ApiClient} onClose={vi.fn()} onSaved={onSaved} />,
    );
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    fireEvent.change(screen.getByLabelText("Area Name"), { target: { value: "  Jumeirah  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedArea));
    // The Area Code is generated server-side and must never be sent.
    expect(api.post).toHaveBeenCalledWith("configuration/areas", {
      emirateId: dubaiId,
      nameAr: "",
      nameEn: "Jumeirah",
      notes: "",
    });
    expect(screen.queryByLabelText("Area Code")).not.toBeInTheDocument();
  });

  it("reuses supplied Emirates when opened inline instead of loading them again", async () => {
    const api = createApi();
    render(
      <AreaFormDialog
        api={api as unknown as ApiClient}
        defaultEmirateId={dubaiId}
        emirates={emirates}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "Dubai" })).toBeInTheDocument();
    expect(screen.getByLabelText("Emirate")).toHaveValue(dubaiId);
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows the duplicate rule against the name field", async () => {
    const api = createApi({
      post: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("conflict"), { code: "area_exists" })),
    });
    render(
      <AreaFormDialog api={api as unknown as ApiClient} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await screen.findByRole("option", { name: "Dubai" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: dubaiId } });
    fireEvent.change(screen.getByLabelText("Area Name"), { target: { value: "Jumeirah" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const message = await screen.findByText(
      "An Area with this name already exists in the selected Emirate.",
    );
    expect(message).toBeInTheDocument();
    expect(screen.getByLabelText("Area Name")).toHaveAttribute("aria-invalid", "true");
  });

  it("edits an existing Area through PATCH and shows its generated code", async () => {
    const api = createApi();
    const onSaved = vi.fn();
    render(
      <AreaFormDialog
        api={api as unknown as ApiClient}
        area={savedArea}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByRole("option", { name: "Dubai" });

    // The generated code is displayed but not editable.
    expect(screen.getByText("AREA-000001")).toBeInTheDocument();
    expect(screen.getByLabelText("Area Name")).toHaveValue("Jumeirah");

    fireEvent.change(screen.getByLabelText("Area Name"), { target: { value: "Jumeirah 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`configuration/areas/${savedArea.id}`, {
        emirateId: dubaiId,
        nameAr: "",
        nameEn: "Jumeirah 1",
        notes: "",
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("explains why an in-use Area cannot change Emirate", async () => {
    const api = createApi({
      patch: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("conflict"), { code: "area_emirate_change_blocked" }),
        ),
    });
    render(
      <AreaFormDialog
        api={api as unknown as ApiClient}
        area={savedArea}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Sharjah" });

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: sharjahId } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
  });

  it("renders Emirate names in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    const api = createApi();
    render(
      <AreaFormDialog api={api as unknown as ApiClient} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(await screen.findByRole("option", { name: "دبي" })).toBeInTheDocument();
    expect(screen.getByText("الإمارة")).toBeInTheDocument();
    await i18nInstance.changeLanguage("en");
  });
});
