import "@testing-library/jest-dom/vitest";

import { configure } from "@testing-library/react";

// Testing Library's async queries (findBy*/waitFor) default to a 1s timeout.
// Under the constrained forks pool a worker can be briefly descheduled while a
// debounced search or data load settles; 1s is then occasionally too tight and
// the query gives up on an element that does arrive moments later. Raising the
// budget makes those queries patient without loosening any assertion — the
// element must still appear for the test to pass.
configure({ asyncUtilTimeout: 5000 });
