const apiBaseUrl = (process.env.SMOKE_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1").replace(
  /\/$/,
  "",
);
const webBaseUrl = (process.env.SMOKE_WEB_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? "5000", 10);

async function check(name, url, expectedContentType) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes(expectedContentType)) {
    throw new Error(`${name} failed with HTTP ${response.status}`);
  }
  process.stdout.write(`${name}: HTTP ${response.status}\n`);
}

try {
  await check("web health", `${webBaseUrl}/healthz`, "application/json");
  await check("API liveness", `${apiBaseUrl}/health/live`, "application/json");
  await check("API readiness", `${apiBaseUrl}/health/ready`, "application/json");
} catch (error) {
  process.stderr.write(
    `Smoke test failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
