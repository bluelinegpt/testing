import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { installCrashReporting } from './error-reporting';
import { installTracking } from './tracking';
import { PreloadContext, readEmbeddedPreloadMap } from './preload-context';
import './styles.css';
import './quote.css';
import './blog.css';
import './blog-index.css';

installCrashReporting();
// Deferred out of the critical rendering path (Lighthouse network-dependency
// finding): analytics configuration is not needed for first paint, and its
// /public/blog/settings request was part of the LCP-blocking chain. Idle
// callback with a timeout floor so it still always runs.
const startTracking = () => void installTracking();
if ("requestIdleCallback" in window) {
  requestIdleCallback(startTracking, { timeout: 4000 });
} else {
  setTimeout(startTracking, 2500);
}

// Data the server already used to render this page (Help articles, SEO
// service pages, Blog articles). Undefined on every other page.
const preloadMap = readEmbeddedPreloadMap();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreloadContext.Provider value={preloadMap}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PreloadContext.Provider>
  </StrictMode>,
);
