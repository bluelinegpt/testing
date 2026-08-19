import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const siteUrl = 'https://tawseelhub.com';
const routes = [
  ['/', 'Delivery Operating System for UAE Delivery Companies', 'Manage orders, drivers, COD, Trader settlements, accounting and payroll with Tawseelhub — delivery management software built for the UAE.'],
  ['/delivery-companies', 'Delivery Management Software UAE | Tawseelhub Delivery Operating System', 'Tawseelhub is a Delivery Operating System for UAE delivery companies, combining orders, drivers, COD collections, Trader settlements, accounting, payroll and reporting.'],
  ['/send-a-package', 'Send a Package Across the UAE', 'Request a delivery quote for a package across the UAE with pickup, destination, package and COD details.'],
  ['/traders', 'Delivery Solutions for Traders & Online Sellers UAE | Tawseelhub', 'Register your business with Tawseelhub, connect your existing Delivery Company or let us help you find a suitable delivery partner for Salla, Shopify, WooCommerce and other sales channels.'],
  ['/traders/register', 'Trader Registration | Tawseelhub', 'Apply to register your UAE business with Tawseelhub and prepare a verified delivery relationship.'],
  ['/integrations', 'Commerce Integrations', 'Prepare to connect Salla, Shopify and WooCommerce orders to delivery operations through planned Tawseelhub integrations.'],
  ['/resources', 'Delivery Operations Resources', 'Practical resources for UAE delivery companies covering COD, failed deliveries, operations and connected sales channels.'],
  ['/blog', 'Tawseelhub Insights', 'Insights for delivery companies and Traders building more connected delivery operations in the UAE.'],
  ['/pricing', 'Tawseelhub Pricing | AED Plans for Delivery Companies', 'Review Tawseelhub pricing in AED, from a free tier up to high-volume delivery operations. Request a demo for the right plan.'],
  ...['delivery-operations','cod-finance','business-growth','last-mile-delivery','uae-delivery-guides','salla','shopify','woocommerce'].map(slug => [`/blog/category/${slug}`, 'Tawseelhub Blog', 'Practical guidance for UAE delivery operations.']),
  ['/about', 'About Tawseelhub', 'Learn why Tawseelhub is building a connected delivery operating system for delivery businesses in the UAE.'],
  ['/contact', 'Contact Tawseelhub', 'Contact the Tawseelhub team about delivery operations, partnerships and the platform.'],
  ['/request-demo', 'Request a Tawseelhub Demo', 'Request a tailored demonstration of Tawseelhub for your UAE delivery company.'],
];

const template = await readFile('dist/index.html', 'utf8');
for (const [path, title, description] of routes) {
  const canonical = `${siteUrl}${path}`;
  const fullTitle = /tawseelhub/i.test(title) ? title : `${title} | Tawseelhub`;
  const metadata = `<link rel="canonical" href="${canonical}" /><link rel="alternate" hreflang="en" href="${canonical}" /><link rel="alternate" hreflang="x-default" href="${canonical}" /><meta property="og:title" content="${fullTitle}" /><meta property="og:description" content="${description}" /><meta property="og:type" content="website" /><meta property="og:url" content="${canonical}" /><meta property="og:image" content="${siteUrl}/og.png" /><meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${fullTitle}" /><meta name="twitter:description" content="${description}" /><meta name="twitter:image" content="${siteUrl}/og.png" />`;
  const html = template
    .replace(/<title>.*?<\/title>/, `<title>${fullTitle}</title>`)
    .replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${description}" />${metadata}`);
  const targetDirectory = path === '/' ? 'dist' : join('dist', path.slice(1));
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(targetDirectory, 'index.html'), html);
}

const sitemapPaths = routes.map(([path]) => path).filter(path => path !== '/traders/register');
try {
  const endpoint = process.env.PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000/api/v1';
  const response = await fetch(`${endpoint}/public/blog/sitemap-entries`);
  if (response.ok) for (const entry of await response.json()) if (!sitemapPaths.includes(entry.path)) sitemapPaths.push(entry.path);
} catch { console.warn('[prerender] Blog sitemap feed unavailable; emitting static public routes only.'); }
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map(path => `  <url><loc>${siteUrl}${path}</loc></url>`).join('\n')}\n</urlset>\n`;
await writeFile('dist/sitemap.xml', sitemap);
