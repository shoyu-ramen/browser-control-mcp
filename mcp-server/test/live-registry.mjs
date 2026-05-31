// Shared singleton used to pass the live tool list out of the stubbed stdio
// transport (which runs inside server.js's module graph) back to the test
// process. Both sides import the same specifier, so they share one object.
export const LIVE_REGISTRY = {
  transport: null,
  tools: null,
};
