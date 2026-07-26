import { promises as fileSystem } from "node:fs";
import { resolve } from "node:path";

const migrationDirectory = resolve("database/migrations");
const supportedMigration = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.(?:js|ts)$/;
const entries = (await fileSystem.readdir(migrationDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== "README.md")
  .map((entry) => entry.name)
  .sort();

if (entries.length === 0) {
  process.stdout.write("No database migrations exist; the schema decision gate remains open.\n");
  process.exit(0);
}

const invalid = entries.filter((name) => !supportedMigration.test(name));
const timestamps = entries.map((name) => supportedMigration.exec(name)?.[1]).filter(Boolean);
const duplicates = timestamps.filter((timestamp, index) => timestamps.indexOf(timestamp) !== index);

if (invalid.length > 0 || duplicates.length > 0) {
  if (invalid.length > 0) process.stderr.write(`Invalid migration names: ${invalid.join(", ")}\n`);
  if (duplicates.length > 0) {
    process.stderr.write(
      `Duplicate migration timestamps: ${[...new Set(duplicates)].join(", ")}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${entries.length} ordered migration file(s).\n`);
}
