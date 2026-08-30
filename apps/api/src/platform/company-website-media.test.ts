import { HttpStatus } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AppConfiguration } from "../configuration/environment.js";
import type { FileStoragePort, StoredFileReference } from "../files/file-storage.port.js";
import { CompanyWebsiteService } from "./company-website.service.js";

/**
 * Uploading a Website logo/banner used to mean reading the file into a
 * base64 data URL and saving it inline in the Website settings JSONB --
 * which is what made the public `/public/company-website` payload
 * multi-megabyte (it's re-transmitted on every visitor's page load). These
 * cover the replacement: the bytes go to storage (R2 in production) at a
 * per-Company key, and only a short URL is ever handed back to the caller.
 *
 * `uploadMedia`/`readMedia` never touch the database, so the other
 * constructor dependencies are stubbed out entirely rather than faked in
 * detail.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const NOT_AN_IMAGE = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>");

class InMemoryWebsiteStorage implements Pick<FileStoragePort, "storeWebsite" | "readWebsite"> {
  private readonly objects = new Map<string, Buffer>();
  public async storeWebsite(key: string, content: Uint8Array): Promise<StoredFileReference> {
    this.objects.set(key, Buffer.from(content));
    return { storageKey: key };
  }
  public async readWebsite(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`No object found for storage key ${key}`);
    return bytes;
  }
}

function service(storage: FileStoragePort, provider: "r2" | "local" = "r2"): CompanyWebsiteService {
  const config = {
    get: (key: string) => (key === "files.provider" ? provider : undefined),
  } as unknown as ConfigService<AppConfiguration, true>;
  return new CompanyWebsiteService(
    undefined as never,
    undefined as never,
    undefined as never,
    storage,
    config,
  );
}

describe("Company website branding media", () => {
  it("stores an uploaded logo/banner and returns a public URL instead of base64", async () => {
    const websites = service(new InMemoryWebsiteStorage() as unknown as FileStoragePort);
    const { url } = await websites.uploadMedia("11111111-1111-1111-1111-111111111111", {
      buffer: PNG,
      mimetype: "image/png",
      size: PNG.length,
    });
    expect(url).toMatch(
      /^\/api\/v1\/public\/company-website\/media\/11111111-1111-1111-1111-111111111111\/[0-9a-f-]{36}\.png$/u,
    );
  });

  it("round-trips the exact bytes back through readMedia", async () => {
    const websites = service(new InMemoryWebsiteStorage() as unknown as FileStoragePort);
    const companyId = "11111111-1111-1111-1111-111111111111";
    const { url } = await websites.uploadMedia(companyId, {
      buffer: PNG,
      mimetype: "image/png",
      size: PNG.length,
    });
    const filename = url.split("/").pop()!;
    const media = await websites.readMedia(companyId, filename);
    expect(Buffer.from(media.bytes).equals(PNG)).toBe(true);
    expect(media.mediaType).toBe("image/png");
    await expect(websites.readUploadedMediaDataUrl(companyId, url)).resolves.toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
  });

  it("refuses Website uploads unless the configured storage provider is R2", async () => {
    const websites = service(new InMemoryWebsiteStorage() as unknown as FileStoragePort, "local");
    await expect(
      websites.uploadMedia("11111111-1111-1111-1111-111111111111", {
        buffer: PNG,
        mimetype: "image/png",
        size: PNG.length,
      }),
    ).rejects.toMatchObject({ errorCode: "website_media_r2_not_configured" });
  });

  it("rejects a file that isn't actually an image", async () => {
    const websites = service(new InMemoryWebsiteStorage() as unknown as FileStoragePort);
    await expect(
      websites.uploadMedia("11111111-1111-1111-1111-111111111111", {
        buffer: NOT_AN_IMAGE,
        mimetype: "image/png",
        size: NOT_AN_IMAGE.length,
      }),
    ).rejects.toMatchObject({ errorCode: "website_media_invalid" });
  });

  it("requires a file to be selected", async () => {
    const websites = service(new InMemoryWebsiteStorage() as unknown as FileStoragePort);
    await expect(
      websites.uploadMedia("11111111-1111-1111-1111-111111111111", undefined),
    ).rejects.toMatchObject({ errorCode: "website_media_required" });
  });

  it("refuses a filename that isn't the exact <uuid>.<ext> shape readMedia generates", async () => {
    const websites = service(new InMemoryWebsiteStorage() as unknown as FileStoragePort);
    await expect(
      websites.readMedia("11111111-1111-1111-1111-111111111111", "../../etc/passwd"),
    ).rejects.toBeInstanceOf(ApplicationException);
    await expect(
      websites.readMedia("11111111-1111-1111-1111-111111111111", "../../etc/passwd"),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it("never lets one Company read another Company's uploaded media", async () => {
    const storage = new InMemoryWebsiteStorage() as unknown as FileStoragePort;
    const websites = service(storage);
    const { url } = await websites.uploadMedia("11111111-1111-1111-1111-111111111111", {
      buffer: PNG,
      mimetype: "image/png",
      size: PNG.length,
    });
    const filename = url.split("/").pop()!;
    await expect(
      websites.readMedia("22222222-2222-2222-2222-222222222222", filename),
    ).rejects.toMatchObject({ errorCode: "company_website_not_available" });
  });
});
