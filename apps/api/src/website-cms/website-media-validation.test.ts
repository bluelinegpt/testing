import { describe, expect, it } from "vitest";

import { imageDimensions, isWebsiteMedia } from "./website-cms.service.js";

describe("website media validation", () => {
  it("reads real PNG dimensions for social metadata", () => {
    const png=Buffer.alloc(24);png.writeUInt32BE(1200,16);png.writeUInt32BE(630,20);
    expect(imageDimensions(png,"image/png")).toEqual({width:1200,height:630});
  });
  it("accepts a structurally identified MP4 within the website-media limit", () => {
    const bytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(isWebsiteMedia(bytes, "video/mp4")).toEqual({
      ok: true,
      mediaType: "video/mp4",
      ext: "mp4",
    });
  });

  it("rejects an MP4 whose declared type is misleading", () => {
    const bytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(isWebsiteMedia(bytes, "image/png")).toEqual({
      ok: false,
      reason: "declared_media_type_mismatch",
    });
  });

  it("rejects unsupported media bytes", () => {
    expect(isWebsiteMedia(Buffer.from("not media"), "video/mp4")).toEqual({
      ok: false,
      reason: "unsupported_media_signature",
    });
  });
});
