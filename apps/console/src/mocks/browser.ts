import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
import { demoEnvironmentHandlers } from "./usage";

// Browser-side worker for opt-in dev mocking (e.g. running the console
// without a live backend). Not used by tests — those run in jsdom and
// use ./server instead. Dev runs get the environment handlers (fake
// session / tenants / stats) on top of the shared set so the whole
// console browses backendless.
export const worker = setupWorker(...handlers, ...demoEnvironmentHandlers);
