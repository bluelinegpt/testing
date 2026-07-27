import type { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";
import { LocalFileStorageAdapter } from "./local-file-storage.adapter.js";

function adapterFor(root: string): LocalFileStorageAdapter {
  const config = {
    get(key: string): string {
      if (key === "files.localRoot") return root;
      if (key === "files.provider") return "local";
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService<AppConfiguration, true>;
  return new LocalFileStorageAdapter(config);
}

async function* bytesOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer;
}

describe("LocalFileStorageAdapter", () => {
  let root: string;
  const company = randomUUID();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "blueline-fs-"));
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("stores, reads back and deletes private bytes under a Company-scoped key", async () => {
    const adapter = adapterFor(root);
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const stored = await adapter.storePrivate(
      company,
      { contentType: "image/png", fileName: "logo.png", sizeBytes: payload.length },
      bytesOf(payload),
    );
    expect(stored.storageKey.startsWith(`logos/${company}/`)).toBe(true);

    const read = await adapter.readPrivate(company, stored.storageKey);
    expect(Buffer.from(read).equals(payload)).toBe(true);

    await adapter.deletePrivate(company, stored.storageKey);
    await expect(adapter.readPrivate(company, stored.storageKey)).rejects.toThrow();
  });

  it("never derives the key from the client filename and avoids collisions", async () => {
    const adapter = adapterFor(root);
    const one = await adapter.storePrivate(
      company,
      { contentType: "image/png", fileName: "../../evil.png", sizeBytes: 1 },
      bytesOf(Buffer.from([1])),
    );
    const two = await adapter.storePrivate(
      company,
      { contentType: "image/png", fileName: "../../evil.png", sizeBytes: 1 },
      bytesOf(Buffer.from([2])),
    );
    expect(one.storageKey).not.toEqual(two.storageKey);
    expect(one.storageKey.includes("..")).toBe(false);
    expect(two.storageKey.includes("evil")).toBe(false);
  });

  it("refuses read/delete of a key belonging to another Company", async () => {
    const adapter = adapterFor(root);
    const other = randomUUID();
    await expect(adapter.readPrivate(company, `logos/${other}/whatever`)).rejects.toThrow(
      /Company scope/,
    );
    await expect(adapter.deletePrivate(company, `logos/${other}/whatever`)).rejects.toThrow(
      /Company scope/,
    );
  });

  it("rejects a key that would traverse outside the storage root", async () => {
    const adapter = adapterFor(root);
    // A key scoped to the company but crafted to climb out of the root.
    await expect(
      adapter.readPrivate(company, `logos/${company}/../../../../etc/passwd`),
    ).rejects.toThrow(/escaped the storage root/);
  });
});
