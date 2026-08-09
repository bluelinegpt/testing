import type { StorefrontMedia } from "../types.js";

/** Shared static-media helpers for the sample catalogues. Placeholders only —
 *  no binary assets, no hotlinking. */
export const image = (label: string, tone: string): StorefrontMedia => ({
  kind: "image",
  label,
  tone,
});

export const video = (label: string, tone: string): StorefrontMedia => ({
  kind: "video",
  label,
  tone,
});

/** A primary shot plus detail shots in related tones. */
export const gallery = (
  name: string,
  tone: string,
  extra: readonly StorefrontMedia[] = [],
): StorefrontMedia[] => [
  image(`${name} — front`, tone),
  image(`${name} — back`, `${tone}-2`),
  image(`${name} — detail`, `${tone}-3`),
  image(`${name} — worn`, `${tone}-4`),
  ...extra,
];

/** Sample order number — clearly demo data, never a real Sales Order. */
export const demoOrderNumber = "SO-DEMO-000001";
