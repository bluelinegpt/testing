import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { PasswordChangeView } from "./PasswordChangeView.js";

describe("PasswordChangeView", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));
  it("changes a temporary password before continuing", async () => {
    const api = { post: vi.fn().mockResolvedValue(undefined) };
    const changed = vi.fn();
    render(<PasswordChangeView api={api as unknown as ApiClient} onChanged={changed} />);
    fireEvent.change(screen.getByLabelText("Current Password"), {
      target: { value: "temporary-password" },
    });
    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "new-secure-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "new-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith("auth/change-password", {
      currentPassword: "temporary-password",
      newPassword: "new-secure-password",
    });
  });

  it("blocks a mismatched confirmation and exposes three accessible visibility controls", () => {
    const api = { post: vi.fn() };
    render(<PasswordChangeView api={api as unknown as ApiClient} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Current Password"), {
      target: { value: "temporary-password" },
    });
    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "new-secure-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "different-password" },
    });

    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));

    expect(screen.getAllByText("New Password and Confirm New Password must match.")).toHaveLength(
      2,
    );
    expect(api.post).not.toHaveBeenCalled();
  });
});
