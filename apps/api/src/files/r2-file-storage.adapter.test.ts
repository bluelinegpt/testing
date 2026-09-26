import type { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfiguration } from "../configuration/environment.js";

// In-memory stand-in for the R2 bucket: PutObjectCommand writes into it,
// GetObjectCommand reads back a Body with the real transformToByteArray
// shape the adapter actually calls, DeleteObjectCommand removes the key.
// NoSuchKey mirrors the real SDK's error class so the adapter's own
// `error instanceof NoSuchKey` branch is exercised, not bypassed.
const bucket = new Map<string, { body: Uint8Array; contentType: string | undefined }>();

class FakeNoSuchKey extends Error {
  public override readonly name = "NoSuchKey";
}

const send = vi.fn(async (command: unknown) => {
  const name = (command as { constructor: { name: string } }).constructor.name;
  const input = (command as { input: Record<string, unknown> }).input;
  if (name === "PutObjectCommand") {
    bucket.set(input.Key as string, {
      body: input.Body as Uint8Array,
      contentType: input.ContentType as string | undefined,
    });
    return {};
  }
  if (name === "GetObjectCommand") {
    const object = bucket.get(input.Key as string);
    if (object === undefined) throw new FakeNoSuchKey("not found");
    return { Body: { transformToByteArray: async () => object.body } };
  }
  if (name === "DeleteObjectCommand") {
    bucket.delete(input.Key as string);
    return {};
  }
  throw new Error(`Unhandled command ${name}`);
});

// A plain class, not `vi.fn().mockImplementation(() => ({...}))`: the
// adapter calls `new S3Client(...)`, and an arrow function passed to
// mockImplementation can never satisfy `new` (arrow functions have no
// [[Construct]]) -- it throws "is not a constructor" regardless of the
// vi.fn() wrapper around it.
class FakeS3Client {
  public readonly send = send;
}

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  return {
    ...actual,
    NoSuchKey: FakeNoSuchKey,
    S3Client: FakeS3Client,
  };
});

const { R2FileStorageAdapter } = await import("./r2-file-storage.adapter.js");

function adapterFor(): InstanceType<typeof R2FileStorageAdapter> {
  const config = {
    get(key: string): unknown {
      if (key === "files.r2") {
        return {
          accessKeyId: "test-access-key",
          accountId: "test-account",
          bucketName: "test-bucket",
          secretAccessKey: "test-secret",
        };
      }
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService<AppConfiguration, true>;
  return new R2FileStorageAdapter(config);
}

async function* bytesOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer;
}

describe("R2FileStorageAdapter", () => {
  const company = randomUUID();

  beforeEach(() => {
    bucket.clear();
    send.mockClear();
  });

  it("throws at construction when files.r2 is unset, rather than failing later on first use", () => {
    const config = {
      get(): undefined {
        return undefined;
      },
    } as unknown as ConfigService<AppConfiguration, true>;
    expect(() => new R2FileStorageAdapter(config)).toThrow(/files\.r2/);
  });

  it("stores, reads back and deletes private bytes under a Company-scoped key", async () => {
    const adapter = adapterFor();
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

  it("refuses to read a Company's private key under another Company's scope", async () => {
    const adapter = adapterFor();
    const otherCompany = randomUUID();
    const stored = await adapter.storePrivate(
      company,
      { contentType: "image/png", fileName: "logo.png", sizeBytes: 1 },
      bytesOf(Buffer.from([1])),
    );
    await expect(adapter.readPrivate(otherCompany, stored.storageKey)).rejects.toThrow();
    await expect(adapter.deletePrivate(otherCompany, stored.storageKey)).rejects.toThrow();
  });

  it("keeps Commerce and Website objects in their own namespaces, refusing cross-namespace keys", async () => {
    const adapter = adapterFor();
    const commerceStored = await adapter.storeCommerce(
      `commerce/${randomUUID()}/product.jpg`,
      Buffer.from([1, 2, 3]),
    );
    expect(
      Buffer.from(await adapter.readCommerce(commerceStored.storageKey)).equals(
        Buffer.from([1, 2, 3]),
      ),
    ).toBe(true);
    await expect(adapter.readWebsite(commerceStored.storageKey)).rejects.toThrow();
    await expect(adapter.deleteWebsite(commerceStored.storageKey)).rejects.toThrow();

    const websiteStored = await adapter.storeWebsite(
      `website/${randomUUID()}/banner.jpg`,
      Buffer.from([4, 5, 6]),
    );
    expect(
      Buffer.from(await adapter.readWebsite(websiteStored.storageKey)).equals(
        Buffer.from([4, 5, 6]),
      ),
    ).toBe(true);
    await expect(adapter.readCommerce(websiteStored.storageKey)).rejects.toThrow();

    await adapter.deleteCommerce(commerceStored.storageKey);
    await adapter.deleteWebsite(websiteStored.storageKey);
    await expect(adapter.readCommerce(commerceStored.storageKey)).rejects.toThrow();
    await expect(adapter.readWebsite(websiteStored.storageKey)).rejects.toThrow();
  });

  it("never derives the storage key from the client-supplied filename", async () => {
    const adapter = adapterFor();
    const stored = await adapter.storePrivate(
      company,
      { contentType: "image/png", fileName: "../../evil.png", sizeBytes: 1 },
      bytesOf(Buffer.from([1])),
    );
    expect(stored.storageKey).not.toContain("evil");
    expect(stored.storageKey).not.toContain("..");
  });
});
