import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { AppConfiguration } from "../configuration/environment.js";
import {
  type FileDescriptor,
  FileStoragePort,
  type StoredFileReference,
} from "./file-storage.port.js";

/**
 * Local-filesystem implementation of {@link FileStoragePort}.
 *
 * Bytes are written under a configured private root directory that lives
 * outside any web root — nothing serves this directory statically. Files are
 * addressed only by the server-generated `storageKey`; the key is never derived
 * from a client-supplied filename, and every resolved path is verified to stay
 * within the root so a crafted key cannot traverse out of it.
 */
@Injectable()
export class LocalFileStorageAdapter extends FileStoragePort {
  private readonly root: string;
  private readonly provider: string;

  public constructor(@Inject(ConfigService) config: ConfigService<AppConfiguration, true>) {
    super();
    this.root = resolve(config.get("files.localRoot", { infer: true }));
    this.provider = config.get("files.provider", { infer: true });
  }

  /** The storage-provider identifier persisted on the file_objects row. */
  public get providerName(): string {
    return this.provider;
  }

  public async storePrivate(
    companyId: string,
    descriptor: FileDescriptor,
    content: AsyncIterable<Uint8Array>,
  ): Promise<StoredFileReference> {
    void descriptor;
    const storageKey = this.resolveKeyForCompany(companyId);
    const absolutePath = this.absolutePathFor(storageKey);
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) chunks.push(chunk);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
    return { storageKey };
  }

  public async readPrivate(companyId: string, storageKey: string): Promise<Uint8Array> {
    if (!storageKey.startsWith(`logos/${companyId}/`)) {
      throw new Error("Refusing to read a storage key outside the Company scope");
    }
    return readFile(this.absolutePathFor(storageKey));
  }

  public async deletePrivate(companyId: string, storageKey: string): Promise<void> {
    // The key must belong to the calling Company; a key for another tenant is
    // refused before any filesystem access.
    if (!storageKey.startsWith(`logos/${companyId}/`)) {
      throw new Error("Refusing to delete a storage key outside the Company scope");
    }
    const absolutePath = this.absolutePathFor(storageKey);
    await rm(absolutePath, { force: true });
  }

  /** Company-scoped, collision-free, filename-independent key. */
  private resolveKeyForCompany(companyId: string): string {
    return `logos/${companyId}/${randomUUID()}`;
  }

  private absolutePathFor(storageKey: string): string {
    const absolutePath = resolve(this.root, storageKey);
    const rootWithSep = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (!absolutePath.startsWith(rootWithSep)) {
      throw new Error("Resolved storage path escaped the storage root");
    }
    return absolutePath;
  }
}
