import { createContext, useContext } from "react";

/**
 * Server-side render data injection, plus its hand-off to the browser.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * Prerendering this app previously meant string-replacing <title>/<meta>
 * tags into an otherwise-empty `<div id="root"></div>` shell: real content
 * (Blog listing, an article, Help articles) only ever appeared after the
 * client fetched it in a `useEffect`, which never runs during a Node
 * `renderToString()` pass -- so every prerendered route had an invisible
 * body regardless of the route.
 *
 * This context lets `entry-server.tsx` hand a component the data it would
 * otherwise fetch, so a single synchronous render pass already has real
 * content to show. `getPreloaded()` is read once, as a `useState`
 * initializer -- exactly the point at which React allows a value to appear
 * on the very first render without waiting on an effect.
 *
 * ===========================================================================
 * CLIENT HAND-OFF
 * ===========================================================================
 *
 * For pages the Node server renders on request (Help articles, SEO service
 * pages, Blog articles -- see serve.mjs), the server also embeds the exact
 * data it rendered with as `<script id="tawseelhub-preload">`. `main.tsx`
 * reads it with `readEmbeddedPreloadMap()` and provides it here, so the
 * browser's first render shows the same content instead of a "Loading…"
 * state followed by a second API request. On every other page nothing is
 * embedded, the map is `undefined`, and components fetch as before.
 */
export type PreloadMap = ReadonlyMap<string, unknown>;

export const PreloadContext = createContext<PreloadMap | undefined>(undefined);

/** Read once, as a `useState` initializer -- never inside an effect. */
export function useIsPreloading(): boolean {
  return useContext(PreloadContext) !== undefined;
}

export function getPreloaded<T>(map: PreloadMap | undefined, key: string): T | undefined {
  return map?.get(key) as T | undefined;
}

/** Reads the server-embedded preload data (see serve.mjs embedPreloadData). */
export function readEmbeddedPreloadMap(): PreloadMap | undefined {
  if (typeof document === "undefined") return undefined;
  const element = document.getElementById("tawseelhub-preload");
  if (!element?.textContent) return undefined;
  try {
    const entries = JSON.parse(element.textContent) as Array<[string, unknown]>;
    return Array.isArray(entries) ? new Map(entries) : undefined;
  } catch {
    return undefined;
  }
}
