import { describe, expect, it } from 'vitest';
import { routeDefinitions } from './App';

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
});
