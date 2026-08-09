import { createHash } from "node:crypto";

/**
 * Canonical serialisation and the template hash.
 *
 * ---------------------------------------------------------------------------
 * THE FILE ON DISK IS THE CANONICAL FORM
 * ---------------------------------------------------------------------------
 *
 * Rather than hashing some internal projection and writing a differently
 * formatted file, the exporter writes exactly the canonical bytes. The hash is
 * then simply the SHA-256 of the file, and anyone can recompute it with
 * `sha256sum` without needing this code. A hash that could only be reproduced
 * by running the exporter would be far weaker evidence of what a Company was
 * initialised from.
 *
 * Canonical means: object keys sorted, two-space indentation, LF line endings,
 * one trailing newline. Array order is NOT sorted here — it is the exporter's
 * job to emit arrays in a deterministic order (accounts by code, mappings by
 * mapping key), because sorting arrays blindly would reorder rows whose order
 * carries meaning.
 *
 * ---------------------------------------------------------------------------
 * NOTHING VOLATILE IS SERIALISED
 * ---------------------------------------------------------------------------
 *
 * There is no `exportedAt`, no run identifier and no random value anywhere in
 * the format, so the question of excluding volatile fields from the hash never
 * arises. Two exports of unchanged configuration produce identical bytes and
 * therefore an identical hash. A test asserts exactly that.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      sorted[key] = sortValue(entry);
    }
    return sorted;
  }
  return value;
}

/** The exact bytes the template file holds. */
export function canonicalise(template: unknown): string {
  return `${JSON.stringify(sortValue(template as JsonValue), null, 2)}\n`;
}

/** SHA-256 of the canonical form — identical to `sha256sum` of the written file. */
export function templateSha256(template: unknown): string {
  return createHash("sha256").update(canonicalise(template), "utf8").digest("hex");
}
