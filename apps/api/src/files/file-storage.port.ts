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

  public abstract deletePrivate(companyId: string, storageKey: string): Promise<void>;
}
