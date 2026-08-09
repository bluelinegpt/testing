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

  /**
   * Write Commerce bytes at a server-generated key.
   *
   * Separate from `storePrivate` because the two scope their keys differently
   * and must not be able to reach each other's namespace: Company objects live
   * under `logos/{companyId}/`, Commerce objects under
   * `commerce/{traderCommerceId}/`. Sharing one method would mean one caller's
   * mistake could write a Commerce file into a Company's tree.
   *
   * The key is produced by `commerceStorageKey` and passed in, rather than
   * derived here, because it encodes the Storefront and Product the upload was
   * authorised against — facts this adapter has no way to know.
   */
  public abstract storeCommerce(
    storageKey: string,
    content: Uint8Array,
  ): Promise<StoredFileReference>;

  public abstract readCommerce(storageKey: string): Promise<Uint8Array>;

  public abstract deleteCommerce(storageKey: string): Promise<void>;
}
