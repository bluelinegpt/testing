// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourcesSection } from './App';

/**
 * Regression coverage for the homepage "Insights & Resources" cards.
 *
 * These used to be four hardcoded, fictional article previews whose "Read
 * preview" link always went to the generic /blog listing -- never to the
 * actual article, because there was no actual article backing the card.
 * The section now fetches real published articles and links each card to
 * its own slug; when there are none yet, it shows an honest empty state
 * instead of fabricated content.
 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('homepage Insights & Resources section', () => {
  it('links each card to its own article, not the generic /blog listing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { slug: 'cod-reconciliation-basics', title: 'COD Reconciliation Basics', excerpt: 'A practical look.', category: 'Operations' },
          { slug: 'reduce-failed-deliveries', title: 'Reduce Failed Deliveries', excerpt: 'Simple patterns.', category: 'Service quality' },
        ],
      }),
    }));
    render(<MemoryRouter><ResourcesSection /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('COD Reconciliation Basics')).toBeInTheDocument());
    const links = screen.getAllByRole('link', { name: /Read article/i });
    expect(links.map((link) => link.getAttribute('href')).sort()).toEqual([
      '/blog/cod-reconciliation-basics',
      '/blog/reduce-failed-deliveries',
    ]);
    // No card ever falls back to the generic listing as its own link.
    for (const link of links) expect(link.getAttribute('href')).not.toBe('/blog');
  });

  it('shows an honest empty state instead of fabricated articles when none are published', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
    render(<MemoryRouter><ResourcesSection /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/coming soon/i)).toBeInTheDocument());
    expect(screen.queryByText(/Read article/i)).not.toBeInTheDocument();
  });
});
