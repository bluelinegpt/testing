import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const port = Number.parseInt(process.env.WEB_PORT ?? "8080", 10);
const publicDirectory = resolve(process.env.WEB_ROOT ?? "dist");
/**
 * Same-origin API proxy, mirroring `apps/platform-web/serve.mjs`. The session
 * cookie is HttpOnly `SameSite=Lax` by design, so the API must be reachable
 * under the portal's own origin — exactly what the Vite dev server already
 * does locally. Two headers matter on the way through:
 *   - Host is rewritten to the API's own name, because hosting routers
 *     direct requests by Host and would refuse the portal's.
 *   - `x-blueline-tenant-host` carries the ORIGINAL host, because that is
 *     how the API tells WHICH Company portal (`dana.tawseelhub.com`,
 *     `xyz.tawseelhub.com`, ...) a sign-in belongs to.
 * Set API_PROXY_TARGET to the API service origin and build the SPA with the
 * relative VITE_API_BASE_URL=/api/v1.
 */
const apiProxyTarget = process.env.API_PROXY_TARGET;
const proxyTargetUrl = apiProxyTarget === undefined ? undefined : new URL(apiProxyTarget);

function proxyApi(request, response) {
  const makeRequest = proxyTargetUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = makeRequest(
    {
      headers: {
        ...request.headers,
        host: proxyTargetUrl.host,
        "x-blueline-tenant-host": request.headers.host ?? "",
        "x-forwarded-proto": "https",
      },
      hostname: proxyTargetUrl.hostname,
      method: request.method,
      path: request.url,
      port: proxyTargetUrl.port === "" ? undefined : Number(proxyTargetUrl.port),
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "application/json" });
    response.end('{"error":{"code":"bad_gateway","message":"API upstream unreachable"}}');
  });
  request.pipe(upstream);
}
const connectSources = process.env.WEB_CONNECT_SRC ?? "'self' https:";
if (/[;\r\n]/.test(connectSources)) {
  throw new Error("WEB_CONNECT_SRC contains invalid CSP characters");
}
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function addSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src ${connectSources}; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
  );
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function resolveAsset(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return undefined;
  }
  const candidate = resolve(publicDirectory, `.${normalize(pathname)}`);
  const relativePath = relative(publicDirectory, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(publicDirectory, "index.html");
}

const server = createServer((request, response) => {
  if (proxyTargetUrl !== undefined && (request.url ?? "").startsWith("/api/")) {
    proxyApi(request, response);
    return;
  }
  addSecurityHeaders(response);
  if (request.url === "/healthz") {
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const asset = resolveAsset(request.url ?? "/");
  if (asset === undefined || !existsSync(asset)) {
    response.writeHead(404);
    response.end();
    return;
  }

  const immutable = asset.startsWith(`${join(publicDirectory, "assets")}${sep}`);
  response.writeHead(200, {
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Type": contentTypes.get(extname(asset)) ?? "application/octet-stream",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(asset).pipe(response);
});

function shutdown() {
  server.close((error) => {
    process.exitCode = error === undefined ? 0 : 1;
  });
}

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`BluelineGPT web listening on port ${port}\n`);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
