import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Metadata spot-checks. These target specific routes and, for the Blog
 * article check, a real published article that only exists once the build
 * runs against the deployed test API (its `og:image` is hardcoded to that
 * host) -- so this section is skipped file-by-file when the referenced
 * page wasn't generated (e.g. a local build against a dev database with no
 * published articles), rather than failing the whole script on an
 * environment mismatch that has nothing to do with prerender correctness.
 */
const checks = [
  {
    file: "dist/index.html",
    expected: [
      "<title>Delivery Operating System for Delivery Companies | Tawseelhub</title>",
      '<link rel="canonical" href="https://tawseelhub.com/"',
      '<meta property="og:type" content="website"',
    ],
  },
  {
    file: "dist/blog/manage-cod-delivery-operations/index.html",
    expected: [
      "<title>COD Management for Delivery Companies | Tawseelhub</title>",
      '<meta name="description" content="Learn how delivery companies can improve COD collection, driver reconciliation and Trader settlements with Tawseelhub."',
      '<link rel="canonical" href="https://tawseelhub.com/blog/manage-cod-delivery-operations"',
      '<meta property="og:type" content="article"',
      '<meta property="og:image" content="https://bluelinegpt-api-test.onrender.com/api/v1/public/website/media/45551888-8c46-4026-802b-3dcba4038e6b"',
    ],
  },
  {
    file: "dist/resources/what-is-tawseelhub/index.html",
    expected: [
      "<title>What is Tawseelhub? | Help Center</title>",
      '<meta name="description" content="Learn what Tawseelhub does for UAE delivery companies, Traders and shipment customers."',
      '<link rel="canonical" href="https://tawseelhub.com/resources/what-is-tawseelhub"',
      '<meta property="og:type" content="website"',
    ],
  },
];

for (const check of checks) {
  let html;
  try {
    html = await readFile(check.file, "utf8");
  } catch {
    console.warn(
      `[verify-prerender] Skipping ${check.file} -- not generated in this build (expected on a local build without this exact published content).`,
    );
    continue;
  }
  for (const expected of check.expected) {
    if (!html.includes(expected)) {
      throw new Error(`Missing prerender metadata in ${check.file}: ${expected}`);
    }
  }
}

console.log(
  "Prerender metadata output verified (for whichever of the above pages this build actually generated).",
);

/**
 * Regression guard for the empty-body defect -- the actual point of this
 * script. Every generated public page used to prerender only <head>
 * metadata into an otherwise-empty `<div id="root"></div>` shell: a
 * crawler that doesn't execute JavaScript saw no H1, no body copy, nothing,
 * on every single route. This walks every generated dist/**\/index.html
 * and fails the moment one comes back with an empty root, so that
 * regression can never silently return regardless of which specific
 * routes a given build happened to generate.
 */
async function findGeneratedPages(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findGeneratedPages(full)));
    } else if (entry.name === "index.html") {
      files.push(full);
    }
  }
  return files;
}

const emptyRootPattern = /<div id="root">\s*(<link[^>]*>\s*)*<\/div>/;
const pages = await findGeneratedPages("dist");
if (pages.length === 0) throw new Error("No generated dist/**/index.html pages found to verify.");
const emptyPages = [];
for (const page of pages) {
  const html = await readFile(page, "utf8");
  if (!html.includes('<div id="root">')) {
    emptyPages.push(`${page} (no #root element at all)`);
    continue;
  }
  if (emptyRootPattern.test(html)) {
    emptyPages.push(page);
  }
}
if (emptyPages.length > 0) {
  throw new Error(
    `${emptyPages.length} of ${pages.length} generated page(s) have an empty <div id="root">` +
      ` -- a crawler without JavaScript would see no visible content:\n  ${emptyPages.join("\n  ")}`,
  );
}
console.log(
  `Prerender body content verified non-empty across all ${pages.length} generated pages.`,
);

const bytesCheck = await stat("dist/index.html");
if (bytesCheck.size < 2000) {
  throw new Error(
    `dist/index.html is only ${bytesCheck.size} bytes -- suspiciously small for a page with real body content.`,
  );
}
