import { describe, expect, it } from 'vitest';
import { isDynamicContentRoute, routeDefinitions } from './App';
import { routeMetadata } from './public-localization';

describe('public website route foundation', () => {
  it('includes every required public route exactly once', () => {
    const paths = routeDefinitions.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([
      '/', '/delivery-companies', '/send-a-package', '/traders', '/traders/register', '/integrations',
      '/resources', '/blog', '/pricing', '/about', '/contact', '/request-demo',
    ]);
  });

  it('provides unique metadata for every route', () => {
    expect(new Set(routeDefinitions.map((route) => route.title)).size).toBe(routeDefinitions.length);
    for (const route of routeDefinitions) expect(route.description.length).toBeGreaterThan(50);
  });

  it('lets dynamic Blog and Help pages own their metadata after hydration', () => {
    expect(isDynamicContentRoute('/blog/manage-cod-delivery-operations')).toBe(true);
    expect(isDynamicContentRoute('/blog/category/delivery-operations')).toBe(true);
    expect(isDynamicContentRoute('/resources/what-is-tawseelhub')).toBe(true);
    expect(isDynamicContentRoute('/')).toBe(false);
    expect(isDynamicContentRoute('/blog')).toBe(false);
    expect(isDynamicContentRoute('/resources')).toBe(false);
  });

  it('keeps the Tawseelhub brand un-translated in Arabic metadata', () => {
    const rendered = JSON.stringify(routeMetadata.ar);
    expect(rendered).toContain('Tawseelhub');
    expect(rendered).not.toContain('توصيل هب');
  });
});
