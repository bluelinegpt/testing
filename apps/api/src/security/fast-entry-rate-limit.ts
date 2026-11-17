/**
 * Requests per minute allowed on the three read-only checks Fast Entry makes
 * for every sheet row: price quote, Order identifier availability and the
 * Customer search. The global limit (RATE_LIMIT_MAX, default 100/min) refused
 * large sheets; these checks only read data, and need orders.create.
 * Override with FAST_ENTRY_CHECK_RATE_LIMIT (Aiman, 17 Nov 2026).
 */
const configured = Number.parseInt(process.env.FAST_ENTRY_CHECK_RATE_LIMIT ?? "", 10);
export const FAST_ENTRY_CHECK_RATE_LIMIT = Number.isInteger(configured) && configured > 0 ? configured : 1000;
