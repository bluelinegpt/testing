import { SessionTokenService } from "./session-token.service.js";

describe("SessionTokenService", () => {
  const tokens = new SessionTokenService();

  it("creates opaque tokens and stores only a deterministic SHA-256 hash", () => {
    const first = tokens.create();
    const second = tokens.create();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(tokens.hash(first.token));
    expect(second.token).not.toBe(first.token);
  });
});
