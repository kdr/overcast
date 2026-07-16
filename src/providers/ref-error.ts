// Base for provider script-ref resolution failures. Both `shipped:` and
// `installed:` refs resolve at the same spawn seam (resolveShippedArgv) and can
// each throw when a ref doesn't resolve in this build (missing sidecar / removed
// package). Call sites map either to a structured error record instead of an
// uncaught throw by catching this base — so a new ref scheme is handled by every
// site automatically (invariant: one catch covers the whole class).

export class ProviderRefError extends Error {
  ref: string;
  constructor(message: string, ref: string, name = "ProviderRefError") {
    super(message);
    this.name = name;
    this.ref = ref;
  }
}
