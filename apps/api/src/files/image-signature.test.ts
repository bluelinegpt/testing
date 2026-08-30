import { describe, expect, it } from "vitest";

import { MAX_LOGO_BYTES, validateLogoImage } from "./image-signature.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function png(extra = 16): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(extra, 0x01)]);
}
function jpeg(extra = 16): Buffer {
  return Buffer.concat([JPEG_HEADER, Buffer.alloc(extra, 0x01), Buffer.from([0xff, 0xd9])]);
}

describe("validateLogoImage", () => {
  it("accepts a real PNG", () => {
    const result = validateLogoImage(png(), "image/png");
    expect(result).toEqual({ mediaType: "image/png", ok: true, type: "png" });
  });

  it("accepts a real PNG whose compressed data happens to contain a markup-like substring", () => {
    // Compressed image data is close to random bytes -- it's entirely
    // possible for a genuine PNG to coincidentally decode (as latin1) to
    // contain "<svg" or similar, purely by chance. The markup/script scan
    // must only apply to files that are NOT already a real image by
    // signature, or this rejects legitimate uploads as if they were
    // malicious.
    const collision = Buffer.concat([PNG_HEADER, Buffer.from("<svg-like-bytes>", "latin1")]);
    expect(validateLogoImage(collision, "image/png")).toMatchObject({ ok: true, type: "png" });
  });

  it("accepts a real JPEG and tolerates image/jpg declaration", () => {
    expect(validateLogoImage(jpeg(), "image/jpeg")).toMatchObject({ ok: true, type: "jpeg" });
    expect(validateLogoImage(jpeg(), "image/jpg")).toMatchObject({ ok: true, type: "jpeg" });
  });

  it("accepts a file exactly at the 2 MB limit and rejects one byte over", () => {
    const atLimit = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_LOGO_BYTES - PNG_HEADER.length)]);
    expect(atLimit.length).toBe(MAX_LOGO_BYTES);
    expect(validateLogoImage(atLimit)).toMatchObject({ ok: true, type: "png" });

    const overLimit = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_LOGO_BYTES)]);
    expect(validateLogoImage(overLimit)).toEqual({ ok: false, reason: "file_too_large" });
  });

  it("rejects an empty file", () => {
    expect(validateLogoImage(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_file" });
  });

  it("rejects SVG even when declared as PNG", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "utf8");
    expect(validateLogoImage(svg, "image/png")).toEqual({
      ok: false,
      reason: "markup_or_script_rejected",
    });
  });

  it("rejects HTML and XML documents", () => {
    expect(validateLogoImage(Buffer.from("<!doctype html><html></html>", "utf8"))).toEqual({
      ok: false,
      reason: "markup_or_script_rejected",
    });
    expect(validateLogoImage(Buffer.from('<?xml version="1.0"?><svg/>', "utf8"))).toEqual({
      ok: false,
      reason: "markup_or_script_rejected",
    });
  });

  it("rejects a script payload", () => {
    expect(validateLogoImage(Buffer.from("<script>alert(1)</script>", "utf8"))).toEqual({
      ok: false,
      reason: "markup_or_script_rejected",
    });
  });

  it("rejects an executable renamed/declared as JPG", () => {
    // ELF and PE/DOS headers are not image signatures.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    expect(validateLogoImage(elf, "image/jpeg")).toEqual({
      ok: false,
      reason: "unsupported_image_signature",
    });
    const dos = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(32)]);
    expect(validateLogoImage(dos, "image/jpeg")).toEqual({
      ok: false,
      reason: "unsupported_image_signature",
    });
  });

  it("rejects a mismatch between real bytes and declared media type", () => {
    expect(validateLogoImage(png(), "image/jpeg")).toEqual({
      ok: false,
      reason: "declared_media_type_mismatch",
    });
    expect(validateLogoImage(jpeg(), "image/png")).toEqual({
      ok: false,
      reason: "declared_media_type_mismatch",
    });
  });

  it("accepts valid bytes when no media type is declared", () => {
    expect(validateLogoImage(png())).toMatchObject({ ok: true });
    expect(validateLogoImage(jpeg())).toMatchObject({ ok: true });
  });
});
