import type { HttpHandler } from "msw";

import { usageDemoHandlers } from "./usage";

// MSW handlers shared across the whole test suite. Tests opt in to
// specific responses with `server.use(http.get(...))` rather than
// relying on a big global registry, so this list stays small — only
// add a handler here when many tests would otherwise duplicate it.
//
// The usage demo handlers are inert for tests that never call their
// URLs; they exist so `?mocks=1` dev runs (see main.tsx) can render the
// console without a live backend.
export const handlers: HttpHandler[] = [...usageDemoHandlers];
