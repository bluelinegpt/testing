/**
 * The public portal address for a Company subdomain, derived from where the
 * Platform itself is running rather than from configuration:
 *
 *   platform.tawseelhub.com  ->  https://<subdomain>.tawseelhub.com
 *   localhost:5176 (dev)     ->  http://localhost:5177
 *
 * Deriving from the current host keeps the link correct on any future domain
 * with zero settings — the Platform always lives at `platform.<domain>` and
 * the Company portals at `<subdomain>.<domain>`, by design.
 */
export function companyPortalUrl(subdomain: string): string {
  const { hostname, protocol } = globalThis.location;
  if (hostname.startsWith("platform.")) {
    return `${protocol}//${subdomain}.${hostname.slice("platform.".length)}`;
  }
  void subdomain;
  return "http://localhost:5177";
}
