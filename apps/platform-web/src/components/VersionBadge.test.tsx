import { render, screen } from "@testing-library/react";

import { VersionBadge } from "./VersionBadge.js";

describe("VersionBadge", () => {
  it("shows the Git commit baked into the build", () => {
    render(<VersionBadge />);

    const badge = screen.getByTitle(/^Build /);
    expect(badge).toHaveTextContent(/^[0-9a-f]+$/i);
    expect(badge.textContent).not.toBe("dev");
  });
});
