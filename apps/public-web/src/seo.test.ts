// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPageMetadata, publicRobotsDirective } from './seo';
import { localeFromPublicPath, localizePublicPath, stripPublicLocale } from './public-localization';

afterEach(() => {
  document.head.innerHTML = '';
  document.title = '';
});

describe('single URL public SEO metadata', () => {
  it('uses real Arabic path routing without language query parameters',()=>{
    expect(localeFromPublicPath('/ar/blog/مقال')).toBe('ar');
    expect(stripPublicLocale('/ar/pricing')).toBe('/pricing');
    expect(localizePublicPath('/blog/article','ar')).toBe('/ar/blog/article');
    expect(localizePublicPath('/ar/blog/مقال','en')).toBe('/blog/مقال');
  });
  it('protects local and origin environments from indexing', () => {
    expect(publicRobotsDirective()).toBe('noindex,nofollow');
  });
  it('emits reciprocal localized hreflang only for real URLs', () => {
    applyPageMetadata('COD Management for Delivery Companies | Tawseelhub', 'Manage COD operations.', '/blog/manage-cod-delivery-operations',{locale:'en',alternates:[{language:'en',url:'https://tawseelhub.com/blog/manage-cod-delivery-operations'},{language:'ar',url:'https://tawseelhub.com/ar/blog/إدارة-التحصيل'}]});

    expect(document.head.querySelector('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', 'https://tawseelhub.com/blog/manage-cod-delivery-operations');
    expect(document.head.querySelector('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute('href', 'https://tawseelhub.com/blog/manage-cod-delivery-operations');
    expect(document.head.querySelector('link[rel="alternate"][hreflang="ar"]')).toHaveAttribute('href','https://tawseelhub.com/ar/blog/إدارة-التحصيل');
  });
  it('self-canonicalizes Arabic and omits x-default without an English version',()=>{
    applyPageMetadata('عنوان عربي','وصف عربي','/ar/blog/مقال',{locale:'ar',alternates:[{language:'ar',url:'https://tawseelhub.com/ar/blog/مقال'}],xDefault:null});
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute('href','https://tawseelhub.com/ar/blog/مقال');
    expect(document.head.querySelector('link[hreflang="x-default"]')).toBeNull();
    expect(document.head.querySelector('meta[property="og:locale"]')).toHaveAttribute('content','ar_AE');
  });
  it('renders complete social image metadata and safely serialized schema', () => {
    applyPageMetadata('Social title', 'Social description', '/blog/social', { type:'article', image:'https://tawseelhub.com/social.jpg', imageAlt:'Delivery dashboard', imageWidth:1200, imageHeight:630, locale:'en', schema:{'@context':'https://schema.org','@type':'BlogPosting',headline:'Safe </script>'} });
    expect(document.head.querySelector('meta[property="og:site_name"]')).toHaveAttribute('content','Tawseelhub');
    expect(document.head.querySelector('meta[property="og:image:width"]')).toHaveAttribute('content','1200');
    expect(document.head.querySelector('meta[name="twitter:image:alt"]')).toHaveAttribute('content','Delivery dashboard');
    expect(document.head.querySelector('script[data-seo-schema="true"]')?.textContent).toContain('\\u003c/script>');
  });
});
