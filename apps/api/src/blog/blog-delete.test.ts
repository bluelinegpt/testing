import { describe, expect, it, vi } from "vitest";
import { DummyDriver, Kysely, PostgresDialect } from "kysely";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { BlogService } from "./blog.service.js";

function fixture(status: string, deleted = false) {
  const statements: string[] = [];
  const driver = new DummyDriver();
  vi.spyOn(driver, "acquireConnection").mockResolvedValue({
    executeQuery: async (query: { sql: string }) => {
      statements.push(query.sql);
      const rows = query.sql.includes("select 1 from platform_blog_publication_history") ? (deleted ? [{ found: 1 }] : [])
        : query.sql.startsWith("select") ? [{ id: "article", status, title: "Test article" }] : [];
      return { rows };
    },
    async *streamQuery() { yield { rows: [] }; },
  } as never);
  const dialect = new PostgresDialect({ pool: {} as never });
  vi.spyOn(dialect, "createDriver").mockReturnValue(driver);
  return { service: new BlogService(new Kysely<DatabaseSchema>({ dialect })), statements };
}

describe("blog deletion", () => {
  it.each(["published", "draft", "scheduled", "archived"])("rejects %s articles without mutating", async status => {
    const { service, statements } = fixture(status);
    await expect(service.deleteArticle("article", "actor")).rejects.toThrow("Unpublish");
    expect(statements.some(sql => /^(update|insert|delete)/u.test(sql))).toBe(false);
  });
  it("locks the unpublished article and retains content/history/media", async () => {
    const { service, statements } = fixture("unpublished");
    await service.deleteArticle("article", "actor");
    expect(statements[0]).toContain("for update");
    expect(statements.some(sql => sql.includes("status='archived'"))).toBe(true);
    expect(statements.some(sql => sql.includes("'deleted','unpublished','archived'"))).toBe(true);
    expect(statements.some(sql => /^delete /u.test(sql) || sql.includes("file_objects"))).toBe(false);
  });
  it("rejects deletion, editing and republishing from stale tabs after deletion", async () => {
    const { service, statements } = fixture("archived", true);
    await expect(service.deleteArticle("article", "actor")).rejects.toThrow();
    await expect(service.status("article", { status: "published" }, "actor")).rejects.toThrow();
    await expect(service.update("article", {} as never, "actor")).rejects.toThrow();
    expect(statements.some(sql => /^(update|insert|delete)/u.test(sql))).toBe(false);
  });
  it("excludes deletion markers from the administrator list", async () => {
    const { service, statements } = fixture("archived");
    await service.adminList();
    expect(statements[0]).toContain("not exists");
    expect(statements[0]).toContain("h.event_type='deleted'");
  });
});
