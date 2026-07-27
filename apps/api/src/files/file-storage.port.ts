export interface FileDescriptor {
  readonly contentType: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

export interface StoredFileReference {
  readonly storageKey: string;
}

export abstract class FileStoragePort {
  public abstract storePrivate(
    companyId: string,
    descriptor: FileDescriptor,
    content: AsyncIterable<Uint8Array>,
  ): Promise<StoredFileReference>;

  /**
   * Read previously-stored private bytes for a Company. Used to stream a stored
   * asset (e.g. the Company logo) through an authenticated endpoint — the bytes
   * are never exposed via a public URL. Rejects if the key is missing or does
   * not belong to the Company.
   */
  public abstract readPrivate(companyId: string, storageKey: string): Promise<Uint8Array>;

  public abstract deletePrivate(companyId: string, storageKey: string): Promise<void>;
}
