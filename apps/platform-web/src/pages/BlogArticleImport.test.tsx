import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlogArticleImport, emptyImportFields } from "./BlogArticleImport.js";
import { platformApi } from "../api/platform-client.js";
vi.mock("../api/platform-client.js", () => ({ platformApi: { importBlogArticle: vi.fn() } }));

describe("Blog article import review", () => {
  it("preserves all populated fields including language", () => {
    expect(emptyImportFields({ title: "Existing", language: "en", content: "" }, { title: "Imported", language: "ar", content: "Body" })).toEqual(["content"]);
  });
  it("requires review confirmation, applies only empty fields and never saves", async () => {
    vi.mocked(platformApi.importBlogArticle).mockResolvedValue({ fields: { title: "Imported title", content: "Imported body", language: "ar" }, warnings: [] });
    const apply = vi.fn();
    render(<BlogArticleImport current={{ title: "Keep me", content: "", language: "en" }} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("Or paste Google Docs link"), { target: { value: "https://docs.google.com/document/d/abc/edit" } });
    fireEvent.click(screen.getByText("Prepare import review"));
    await screen.findByText("Review proposed changes");
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Apply Title")).not.toBeChecked();
    fireEvent.click(screen.getByText("Confirm selected fields — do not save"));
    expect(apply).toHaveBeenCalledWith({ content: "Imported body" });
  });
  it("shows import errors without changing the article", async () => {
    vi.mocked(platformApi.importBlogArticle).mockRejectedValue(new Error("Download as .docx"));
    const apply = vi.fn();
    render(<BlogArticleImport current={{}} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("Or paste Google Docs link"), { target: { value: "https://docs.google.com/document/d/private/edit" } });
    fireEvent.click(screen.getByText("Prepare import review"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Download as .docx"));
    expect(apply).not.toHaveBeenCalled();
  });
});
