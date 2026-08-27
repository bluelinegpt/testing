import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";
import { FileOwnershipService } from "./file-ownership.service.js";
import { FileStoragePort } from "./file-storage.port.js";
import { LocalFileStorageAdapter } from "./local-file-storage.adapter.js";
import { R2FileStorageAdapter } from "./r2-file-storage.adapter.js";

// Binds the abstract FileStoragePort to whichever adapter files.provider
// names -- the one place that decides; nothing that depends on FileStoragePort
// needs to know which provider is active.
//
// Deliberately constructs the chosen adapter directly inside the factory,
// rather than registering both LocalFileStorageAdapter and
// R2FileStorageAdapter as their own providers and injecting both in: Nest
// would then eagerly construct BOTH at bootstrap regardless of which is
// active, and R2FileStorageAdapter's constructor throws when files.r2 is
// unset -- exactly the case on every "local"-provider deployment. Only the
// provider actually named ever gets constructed this way.
//
// `FileOwnershipService` is exported alongside it because ownership is a
// property of the file RECORD, not of the bytes: the Storefront domain needs it
// to decide who owns Commerce media without also acquiring a storage provider.
@Module({
  providers: [
    {
      inject: [ConfigService],
      provide: FileStoragePort,
      useFactory: (config: ConfigService<AppConfiguration, true>) =>
        config.get("files.provider", { infer: true }) === "r2"
          ? new R2FileStorageAdapter(config)
          : new LocalFileStorageAdapter(config),
    },
    FileOwnershipService,
  ],
  exports: [FileStoragePort, FileOwnershipService],
})
export class FilesModule {}
