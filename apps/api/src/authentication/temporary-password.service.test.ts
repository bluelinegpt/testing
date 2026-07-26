import { TemporaryPasswordService } from "./temporary-password.service.js";

describe("TemporaryPasswordService", () => {
  it("creates distinct high-entropy passwords that satisfy the current length policy", () => {
    const service = new TemporaryPasswordService();
    const first = service.create();
    const second = service.create();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(20);
    expect(first).toMatch(/[A-Z]/);
    expect(first).toMatch(/[0-9]/);
    expect(first).toContain("!");
  });
});
