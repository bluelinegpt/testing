export function isGuideSitemapEntry(basePath, staticRoutes) {
  return /^\/[^/]+$/.test(basePath) && !Object.hasOwn(staticRoutes, basePath);
}
export function blogLandingCollection(kind) {
  return kind === "category" ? "categories" : `${kind}s`;
}
export function indexableSitemapRoutes(routes, origin) {
  return routes.filter((route) => !route.robots?.includes("noindex")
    && (!route.canonical || route.canonical === `${origin}${route.path}`)
    && !route.path.includes("?") && !route.path.includes("#"));
}
