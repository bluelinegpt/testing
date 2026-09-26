import { describe, expect, it } from 'vitest';
// Vite's `?raw` suffix inlines the file as a plain string at transform time,
// so this test needs no Node `fs`/`path` types in a browser-targeted tsconfig.
import indexHtml from '../index.html?raw';

describe('favicon', () => {
  it('declares an icon link in index.html', () => {
    expect(indexHtml).toMatch(/<link rel="icon"[^>]*href="\/favicon/);
    expect(indexHtml).toContain('apple-touch-icon');
  });
});
