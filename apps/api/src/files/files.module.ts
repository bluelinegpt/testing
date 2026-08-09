import { Module } from "@nestjs/common";

import { FileOwnershipService } from "./file-ownership.service.js";
import { FileStoragePort } from "./file-storage.port.js";
import { LocalFileStorageAdapter } from "./local-file-storage.adapter.js";

// Binds the abstract FileStoragePort to the local-filesystem adapter. Swapping
// in an object-storage adapter later is a one-line change here; nothing that
// depends on FileStoragePort needs to know which provider is active.
//
// `FileOwnershipService` is exported alongside it because ownership is a
// property of the file RECORD, not of the bytes: the Storefront domain needs it
// to decide who owns Commerce media without also acquiring a storage provider.
@Module({
  providers: [
    { provide: FileStoragePort, useClass: LocalFileStorageAdapter },
    FileOwnershipService,
  ],
  exports: [FileStoragePort, FileOwnershipService],
})
export class FilesModule {}
