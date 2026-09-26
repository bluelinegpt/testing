import "@testing-library/jest-dom/vitest";

import { configure } from "@testing-library/react";

// Mirrors the Delivery Portal's setup: the constrained forks pool can briefly
// deschedule a worker while a fetch settles, and 1s is then occasionally too
// tight for an element that does arrive. Patience, not a weaker assertion.
configure({ asyncUtilTimeout: 5000 });
