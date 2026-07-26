import { PasswordHasher } from "./password-hasher.js";

describe("PasswordHasher", () => {
  const hasher = new PasswordHasher();

  it("hashes and verifies a password without storing the password", async () => {
    const hash = await hasher.hash("Correct Horse Battery Staple");
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain("Correct Horse Battery Staple");
    await expect(hasher.verify("Correct Horse Battery Staple", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hasher.hash("correct-password");
    await expect(hasher.verify("incorrect-password", hash)).resolves.toBe(false);
  });

  it("performs a safe dummy comparison for absent or malformed hashes", async () => {
    await expect(hasher.verify("password")).resolves.toBe(false);
    await expect(hasher.verify("password", "invalid")).resolves.toBe(false);
  });
});
