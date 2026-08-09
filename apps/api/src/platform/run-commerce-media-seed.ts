import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import {
  commerceStorageKey,
  extensionFor,
  validateCommerceImage,
} from "../files/commerce-media.constants.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Development-only Commerce MEDIA seed.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEED AND NOT A BROWSER UPLOAD
 * ---------------------------------------------------------------------------
 *
 * The upload endpoints require an authenticated `trader` or `company_user`
 * identity, and this environment has no safe Trader session to sign in with.
 * Rather than fabricate credentials, this drives the SAME server-side pipeline
 * the HTTP controller drives, in the same order:
 *
 *     validateCommerceImage  ->  commerceStorageKey  ->  bytes on disk
 *                            ->  file_objects row owned by trader_commerce
 *
 * What that does and does not prove is worth being precise about. It proves the
 * validator, the key derivation, the storage layout, the ownership shape and
 * the public read path. It does NOT prove the HTTP layer — multipart parsing,
 * the transport byte ceiling, the guard that rejects another Trader's Store.
 * Those are covered by the automated upload tests instead.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BYTES ARE GENERATED RATHER THAN COPIED FROM A FIXTURE
 * ---------------------------------------------------------------------------
 *
 * A checked-in binary is a file nobody reviews. These are real PNGs, built here
 * from a hand-written IHDR/IDAT/IEND with a correct CRC and a correct zlib
 * wrapper, so `validateCommerceImage` sees a genuine PNG signature and a
 * browser renders an actual image. Nothing about the path being exercised is
 * softened to accommodate them.
 *
 * Re-running is safe: a Store that already has a logo, and a Product that
 * already has media, are both left alone.
 */

const STORE_SLUG = "dev-commerce-store";
const PRODUCT_SLUG = "dev-embroidered-abaya";

/** CRC-32, as PNG chunks require. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1));
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Adler-32, as the zlib stream inside IDAT requires. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * A solid-colour PNG, stored uncompressed.
 *
 * Deflate "stored" blocks rather than real compression: the format is simple
 * enough to be obviously correct by reading it, and a decoder cannot tell the
 * difference.
 */
function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }

  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  const maximum = 65_535;
  for (let offset = 0; offset < raw.length; offset += maximum) {
    const slice = raw.subarray(offset, Math.min(offset + maximum, raw.length));
    const final = offset + maximum >= raw.length ? 1 : 0;
    const head = Buffer.alloc(5);
    head[0] = final;
    head.writeUInt16LE(slice.length, 1);
    head.writeUInt16LE(~slice.length & 0xff_ff, 3);
    blocks.push(head, Buffer.from(slice));
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(raw), 0);
  blocks.push(checksum);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.concat(blocks)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const settings = configuration();
  const pool = new Pool({ connectionString: settings.database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const storageRoot = resolve(settings.files.localRoot);

  try {
    const store = await sql<{
      id: string;
      logoFileId: string | null;
      traderCommerceId: string;
    }>`
      select id, logo_file_id as "logoFileId", trader_commerce_id as "traderCommerceId"
        from trader_storefronts where slug = ${STORE_SLUG}
    `.execute(database);
    const storeRow = store.rows[0];
    if (storeRow === undefined) {
      process.stderr.write(`No Store with slug ${STORE_SLUG}. Run dev:seed-commerce first.\n`);
      process.exitCode = 1;
      return;
    }

    const product = await sql<{ id: string }>`
      select id from trader_storefront_products
       where slug = ${PRODUCT_SLUG} and storefront_id = ${storeRow.id}::uuid
    `.execute(database);
    const productRow = product.rows[0];

    /** Validate, key, write, record — the controller's order, unchanged. */
    const store_ = async (
      bytes: Buffer,
      purpose: "cover" | "logo" | "product_image",
      productId?: string,
    ): Promise<string> => {
      const validation = validateCommerceImage(bytes, purpose, "image/png");
      if (!validation.ok) throw new Error(`Generated PNG rejected: ${validation.reason}`);

      const key = commerceStorageKey({
        extension: extensionFor(validation.type),
        purpose,
        storefrontId: storeRow.id,
        traderCommerceId: storeRow.traderCommerceId,
        unique: randomUUID(),
        ...(productId === undefined ? {} : { productId }),
      });
      const absolute = resolve(storageRoot, key);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });

      const inserted = await sql<{ id: string }>`
        insert into file_objects (
          owner_type, company_id, trader_commerce_id,
          storage_provider, storage_key, original_filename, media_type, size_bytes,
          sha256, classification, scan_status
        ) values (
          'trader_commerce', null, ${storeRow.traderCommerceId}::uuid,
          ${settings.files.provider}, ${key}, ${`${purpose}.png`},
          ${validation.mediaType}, ${bytes.length},
          ${createHash("sha256").update(bytes).digest("hex")},
          'private', 'clean'
        )
        returning id
      `.execute(database);
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("file_objects insert returned no row");
      return row.id;
    };

    if (storeRow.logoFileId === null) {
      // Deep navy, matching the approved Store palette rather than a random
      // colour that would look like a rendering bug in a screenshot.
      const fileId = await store_(solidPng(256, [16, 25, 54]), "logo");
      await sql`
        update trader_storefronts set logo_file_id = ${fileId}::uuid, updated_at = now()
         where id = ${storeRow.id}::uuid
      `.execute(database);
      process.stdout.write(`Store logo created: ${fileId}\n`);
    } else {
      process.stdout.write("Store already has a logo; left unchanged.\n");
    }

    if (productRow !== undefined) {
      const existing = await sql<{ count: string }>`
        select count(*)::text as count from trader_storefront_product_media
         where product_id = ${productRow.id}::uuid
      `.execute(database);
      if (existing.rows[0]?.count === "0") {
        const fileId = await store_(solidPng(512, [79, 99, 246]), "product_image", productRow.id);
        await sql`
          insert into trader_storefront_product_media
            (company_id, storefront_id, product_id, media_type, file_id,
             alt_text, display_order, is_primary)
          values (null, ${storeRow.id}::uuid, ${productRow.id}::uuid, 'image',
                  ${fileId}::uuid, 'Dev Embroidered Abaya', 0, true)
        `.execute(database);
        process.stdout.write(`Product image created: ${fileId}\n`);
      } else {
        process.stdout.write("Product already has media; left unchanged.\n");
      }
    }
  } finally {
    await database.destroy();
  }
}

void main();
