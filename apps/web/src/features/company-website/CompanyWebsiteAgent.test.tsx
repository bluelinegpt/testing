import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanyWebsiteAgent from "./CompanyWebsiteAgent.js";

afterEach(() => vi.restoreAllMocks());

describe("CompanyWebsiteAgent", () => {
  it("starts a hostname-bound conversation and renders the Company identity", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          conversationToken: "a".repeat(43),
          assistantName: "Dana Assistant",
          message: "Hi, I'm Dana's assistant.",
          suggestedActions: ["track"],
        }),
        { status: 201 },
      ),
    );
    render(
      <CompanyWebsiteAgent
        agent={{ suggestedActions: ["track"] }}
        apiBase="/api/v1"
        language="en"
        overrideHost="dana.tawseelhub.com"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open website assistant" }));
    expect(await screen.findByText("Hi, I'm Dana's assistant.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/agent/conversations"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-blueline-tenant-host": "dana.tawseelhub.com" }),
      }),
    );
  });
  it("keeps the website usable when the provider endpoint fails and supports Arabic RTL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }));
    render(
      <CompanyWebsiteAgent agent={{ suggestedActions: [] }} apiBase="/api/v1" language="ar" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "فتح مساعد الموقع" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").closest("aside")).toHaveAttribute("dir", "rtl"),
    );
    expect(await screen.findByText(/المساعد غير متاح/u)).toBeInTheDocument();
  });
});
