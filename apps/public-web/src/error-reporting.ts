import { apiUrl } from "./api-base";

type ErrorPayload = { message: string; stack: string | undefined; url: string; app: string };
async function report(payload: ErrorPayload) { try { await fetch(apiUrl('/errors/public'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }); } catch { /* Reporting must never cause a second crash. */ } }
export function installCrashReporting() { window.addEventListener('error', (event) => void report({ message: event.message || 'Uncaught client error', stack: event.error instanceof Error ? event.error.stack : undefined, url: location.href, app: 'public-web' })); window.addEventListener('unhandledrejection', (event) => { const reason = event.reason; void report({ message: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined, url: location.href, app: 'public-web' }); }); }
