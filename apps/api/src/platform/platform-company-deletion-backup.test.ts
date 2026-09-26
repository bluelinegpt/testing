import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runBackupProcess } from "./platform-company-deletion-backup.service.js";

describe("Company deletion backup process", () => {
  it("reports a successful fixed child process", async () => {
    const result = await runBackupProcess({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ exitCode: 0, timedOut: false });
  });

  it("terminates a process that exceeds the approved timeout", async () => {
    const result = await runBackupProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      timeoutMs: 20,
    });
    expect(result.timedOut).toBe(true);
  });

  it("reports a non-zero backup process exit without exposing output", async () => {
    const result = await runBackupProcess({
      executable: process.execPath,
      args: ["-e", "process.exit(7)"],
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ exitCode: 7, timedOut: false });
  });

  it("keeps command, database arguments and paths out of the browser contract", async () => {
    const dto = await readFile(resolve(process.cwd(), "src/platform/platform-company.dto.ts"), "utf8");
    const controller = await readFile(resolve(process.cwd(), "src/platform/platform-company.controller.ts"), "utf8");
    expect(dto).not.toMatch(/backup(Command|Path|Arguments|Executable)/);
    expect(controller).toContain('Post("deletion-backup")');
    expect(controller).toContain("PLATFORM_COMPANIES_DELETE");
  });
});
