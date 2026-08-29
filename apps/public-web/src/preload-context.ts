import { createContext, useContext } from "react";

/**
 * Server-side prerender data injection -- SSR-only, zero client effect.
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
 * WHY THIS CANNOT CHANGE CLIENT BEHAVIOR
 * ===========================================================================
 *
 * `main.tsx` never provides `PreloadContext` -- only `entry-server.tsx`
 * (Node-only, never shipped to the browser) does. In the browser the
 * context value is always `undefined`, so `getPreloaded()` always returns
 * `undefined` and every effect below falls through to its original fetch,
 * exactly as before this change. This module adds a value only the SSR
 * pass can ever see; it removes nothing the client already did.
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
