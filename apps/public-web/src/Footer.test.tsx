// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Footer } from './App';

/**
 * Privacy Policy and Terms of Service used to both point at /resources (the
 * Help Center) because no dedicated legal route existed yet. Now that
 * /privacy and /terms are real pages, the footer must link straight to
 * them rather than the generic Help Center fallback.
 */
afterEach(cleanup);

describe('site footer legal links', () => {
  it('links Privacy Policy and Terms of Service to their own routes', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
  });

  it('keeps Guides and FAQs pointed at the existing Help Center rather than a duplicate route', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Guides' })).toHaveAttribute('href', '/resources');
    expect(screen.getByRole('link', { name: 'FAQs' })).toHaveAttribute('href', '/resources');
  });
});
