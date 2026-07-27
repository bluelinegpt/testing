import { Module } from "@nestjs/common";

import { FileStoragePort } from "./file-storage.port.js";
import { LocalFileStorageAdapter } from "./local-file-storage.adapter.js";

// Binds the abstract FileStoragePort to the local-filesystem adapter. Swapping
// in an object-storage adapter later is a one-line change here; nothing that
// depends on FileStoragePort needs to know which provider is active.
@Module({
  providers: [{ provide: FileStoragePort, useClass: LocalFileStorageAdapter }],
  exports: [FileStoragePort],
})
export class FilesModule {}
