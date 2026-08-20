import { readFile } from 'node:fs/promises';

const checks = [
  {
    file: 'dist/index.html',
    expected: [
      '<title>Delivery Operating System for UAE Delivery Companies | Tawseelhub</title>',
      '<link rel="canonical" href="https://tawseelhub.com/"',
      '<meta property="og:type" content="website"',
    ],
  },
  {
    file: 'dist/blog/manage-cod-delivery-operations/index.html',
    expected: [
      '<title>COD Management for Delivery Companies | Tawseelhub</title>',
      '<meta name="description" content="Learn how delivery companies can improve COD collection, driver reconciliation and Trader settlements with Tawseelhub."',
      '<link rel="canonical" href="https://tawseelhub.com/blog/manage-cod-delivery-operations"',
      '<meta property="og:type" content="article"',
      '<meta property="og:image" content="https://bluelinegpt-api-test.onrender.com/api/v1/public/website/media/45551888-8c46-4026-802b-3dcba4038e6b"',
    ],
  },
  {
    file: 'dist/resources/what-is-tawseelhub/index.html',
    expected: [
      '<title>What is Tawseelhub? | Help Center</title>',
      '<meta name="description" content="Learn what Tawseelhub does for UAE delivery companies, Traders and shipment customers."',
      '<link rel="canonical" href="https://tawseelhub.com/resources/what-is-tawseelhub"',
      '<meta property="og:type" content="website"',
    ],
  },
];

for (const check of checks) {
  const html = await readFile(check.file, 'utf8');
  for (const expected of check.expected) {
    if (!html.includes(expected)) {
      throw new Error(`Missing prerender metadata in ${check.file}: ${expected}`);
    }
  }
}

console.log('Prerender metadata output verified.');
