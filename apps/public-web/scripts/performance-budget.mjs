import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const root = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const initialAssets = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]);
if (!initialAssets.length) throw new Error("No initial Vite assets found. Run the production build first.");
const results = [];
for (const asset of initialAssets) {
  const file = new URL(`.${asset}`, root);
  const body = await readFile(file);
  results.push({ asset, bytes: (await stat(file)).size, gzipBytes: gzipSync(body).length });
}
const totals = results.reduce((sum, item) => ({ bytes: sum.bytes + item.bytes, gzipBytes: sum.gzipBytes + item.gzipBytes }), { bytes: 0, gzipBytes: 0 });
const budget = { bytes: 700_000, gzipBytes: 220_000 };
console.log(JSON.stringify({ initialAssets: results, totals, budget }, null, 2));
if (totals.bytes > budget.bytes || totals.gzipBytes > budget.gzipBytes) throw new Error("Initial JS/CSS performance budget exceeded.");
