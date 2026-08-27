import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";

import type { AppConfiguration } from "../configuration/environment.js";
import {
  type FileDescriptor,
  FileStoragePort,
  type StoredFileReference,
} from "./file-storage.port.js";

/**
 * Cloudflare R2 (S3-compatible) implementation of {@link FileStoragePort}.
 *
 * Mirrors {@link LocalFileStorageAdapter} exactly: same key namespaces
 * (`logos/{companyId}/`, `commerce/`, `website/`), same guards refusing a key
 * outside its own namespace, same never-derive-a-key-from-the-client rule.
 * Swapping providers changes nothing about how the rest of the app addresses
 * or authorises files -- only where the bytes physically live.
 *
 * R2's S3-compatible endpoint is `https://{accountId}.r2.cloudflarestorage.com`;
 * `region` is always the literal string "auto" -- R2's own convention, not a
 * real AWS region, since R2 buckets aren't region-pinned the way S3's are.
 */
@Injectable()
export class R2FileStorageAdapter extends FileStoragePort {
  private readonly bucket: string;
  private readonly client: S3Client;

  public constructor(@Inject(ConfigService) config: ConfigService<AppConfiguration, true>) {
    super();
    const r2 = config.get("files.r2", { infer: true });
    if (r2 === undefined) {
      throw new Error("files.r2 configuration is required when FILE_STORAGE_PROVIDER=r2");
    }
    this.bucket = r2.bucketName;
    this.client = new S3Client({
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      region: "auto",
    });
  }

  public get providerName(): string {
    return "r2";
  }

  public async storePrivate(
    companyId: string,
    descriptor: FileDescriptor,
    content: AsyncIterable<Uint8Array>,
  ): Promise<StoredFileReference> {
    const storageKey = `logos/${companyId}/${randomUUID()}`;
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) chunks.push(chunk);
    await this.put(storageKey, Buffer.concat(chunks), descriptor.contentType);
    return { storageKey };
  }

  public async readPrivate(companyId: string, storageKey: string): Promise<Uint8Array> {
    this.assertKey(storageKey, `logos/${companyId}/`);
    return this.get(storageKey);
  }

  public async deletePrivate(companyId: string, storageKey: string): Promise<void> {
    this.assertKey(storageKey, `logos/${companyId}/`);
    await this.delete(storageKey);
  }

  public async storeCommerce(
    storageKey: string,
    content: Uint8Array,
  ): Promise<StoredFileReference> {
    this.assertKey(storageKey, "commerce/");
    await this.put(storageKey, Buffer.from(content));
    return { storageKey };
  }

  public async readCommerce(storageKey: string): Promise<Uint8Array> {
    this.assertKey(storageKey, "commerce/");
    return this.get(storageKey);
  }

  public async deleteCommerce(storageKey: string): Promise<void> {
    this.assertKey(storageKey, "commerce/");
    await this.delete(storageKey);
  }

  public override async storeWebsite(
    storageKey: string,
    content: Uint8Array,
  ): Promise<StoredFileReference> {
    this.assertKey(storageKey, "website/");
    await this.put(storageKey, Buffer.from(content));
    return { storageKey };
  }

  public override async readWebsite(storageKey: string): Promise<Uint8Array> {
    this.assertKey(storageKey, "website/");
    return this.get(storageKey);
  }

  public override async deleteWebsite(storageKey: string): Promise<void> {
    this.assertKey(storageKey, "website/");
    await this.delete(storageKey);
  }

  /** Every namespace check across all six methods narrows to this one guard,
   *  so a caller passing (or forging) a key outside its own tree is refused
   *  before any network call, exactly like the local adapter. */
  private assertKey(storageKey: string, requiredPrefix: string): void {
    if (!storageKey.startsWith(requiredPrefix)) {
      throw new Error(`Refusing to operate on a storage key outside "${requiredPrefix}"`);
    }
  }

  // `wx`-equivalent semantics (refuse to overwrite) aren't available on R2's
  // PutObject the way they are on a local `writeFile` flag -- every key this
  // adapter ever writes carries a fresh randomUUID (storePrivate) or is
  // generated upstream the same way (Commerce/Website callers), so a
  // collision would mean something is badly wrong either way; an overwrite
  // here is exactly as unreachable in practice as the local adapter's `wx`
  // failing, just not enforced by the storage layer itself.
  private async put(storageKey: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: this.bucket,
        ContentType: contentType,
        Key: storageKey,
      }),
    );
  }

  private async get(storageKey: string): Promise<Uint8Array> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      const body = response.Body;
      if (body === undefined) throw new Error(`Empty response body for storage key ${storageKey}`);
      return await body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey) {
        throw new Error(`No object found for storage key ${storageKey}`);
      }
      throw error;
    }
  }

  private async delete(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }
}
