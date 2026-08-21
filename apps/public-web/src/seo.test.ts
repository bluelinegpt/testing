// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPageMetadata } from './seo';

afterEach(() => {
  document.head.innerHTML = '';
  document.title = '';
});

describe('single URL public SEO metadata', () => {
  it('keeps honest hreflang output until Arabic has a crawlable URL route', () => {
    applyPageMetadata('COD Management for Delivery Companies | Tawseelhub', 'Manage COD operations.', '/blog/manage-cod-delivery-operations');

    expect(document.head.querySelector('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', 'https://tawseelhub.com/blog/manage-cod-delivery-operations');
    expect(document.head.querySelector('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute('href', 'https://tawseelhub.com/blog/manage-cod-delivery-operations');
    expect(document.head.querySelector('link[rel="alternate"][hreflang="ar"]')).toBeNull();
  });
});
