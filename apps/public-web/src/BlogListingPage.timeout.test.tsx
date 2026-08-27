// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlogListingPage } from './BlogPages';

/**
 * The Blog page used to have no request timeout at all: if the underlying
 * fetch never settled (a dropped connection, a dev-server mid-restart, a
 * proxy that swallows the response) neither the success path nor the
 * .catch ever ran, and the page showed "Loading articles..." forever with
 * no way out. A hard client-side timeout guarantees the request always
 * settles, so the page falls back to the retry state instead of hanging
 * indefinitely.
 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Blog listing page — request timeout', () => {
  it('falls back to the retry state instead of hanging forever when the request never resolves', async () => {
    vi.useFakeTimers();
    // A fetch that hangs until aborted -- exactly the failure mode this
    // test guards against, but honoring AbortSignal like a real fetch does,
    // so the test actually exercises the timeout's abort wiring rather than
    // a promise that could never settle under any circumstance.
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));

    render(
      <MemoryRouter initialEntries={['/blog']}>
        <Routes><Route path="/blog" element={<BlogListingPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading articles…')).toBeInTheDocument();

    // Advance past the internal request timeout.
    await act(async () => { await vi.advanceTimersByTimeAsync(13_000); });

    expect(screen.queryByText('Loading articles…')).not.toBeInTheDocument();
    expect(screen.getByText('Articles are temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
