/**
 * Requests per minute allowed on the three read-only checks Fast Entry makes
 * for every sheet row: price quote, Order identifier availability and the
 * Customer search. The global limit (RATE_LIMIT_MAX, default 100/min) refused
 * large sheets; these checks only read data, and need orders.create.
 * Override with FAST_ENTRY_CHECK_RATE_LIMIT (Aiman, 17 Nov 2026).
 */
const configured = Number.parseInt(process.env.FAST_ENTRY_CHECK_RATE_LIMIT ?? "", 10);
export const FAST_ENTRY_CHECK_RATE_LIMIT = Number.isInteger(configured) && configured > 0 ? configured : 1000;

/**
 * Requests per minute on Create Order. Fast Entry creates a large sheet one
 * Order at a time (paced in the browser); the global 100/min is shared by every
 * user while the API cannot see client IPs behind the proxy, so a big sheet
 * starved everyone else. Override with FAST_ENTRY_CREATE_RATE_LIMIT.
 */
const configuredCreate = Number.parseInt(process.env.FAST_ENTRY_CREATE_RATE_LIMIT ?? "", 10);
export const FAST_ENTRY_CREATE_RATE_LIMIT =
  Number.isInteger(configuredCreate) && configuredCreate > 0 ? configuredCreate : 300;
