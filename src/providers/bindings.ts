import { loadSetup } from "../state/setup.js";
import { findProviderChoice } from "./catalog.js";
import { healDescriptor } from "./shipped-ref.js";
import type { ProviderDescriptor } from "../profile.js";
import type { VerbContext } from "../registry/types.js";

function isProviderDescriptor(value: unknown): value is ProviderDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;
  const type = descriptor.type;
  return type === "exec" || type === "http" || type === "inproc" || typeof descriptor.run === "string";
}

export function providerBinding(ctx: VerbContext, verb: string): ProviderDescriptor | undefined {
  const policy = loadSetup(ctx.case)?.providers?.[verb];
  const policyChoice = policy?.choice ? findProviderChoice(verb, policy.choice, ctx.home) : undefined;
  if (policy?.choice && policyChoice?.clearsBinding === true) return undefined;
  const profileDescriptor = ctx.profile.providers?.[verb];
  if (isProviderDescriptor(profileDescriptor)) return profileDescriptor;
  // A case directory is DATA, not configuration authority: `.overcast/setup.json`
  // travels with a shared/published/synced case, so honoring its raw `descriptor`
  // handed an attacker-authored folder the power to choose which binary the first
  // sense verb spawns — with the full environment (API keys included). The case
  // policy may still SELECT a provider, but the executable descriptor is taken
  // from the trusted corpus (catalog + shipped/installed manifests) that
  // `findProviderChoice` resolves, or from the profile in <home>. This is what
  // CLAUDE.md already promised: "Provider execution always follows the active
  // profile binding … never pins a stale exec descriptor."
  if (policyChoice?.descriptor && isProviderDescriptor(policyChoice.descriptor)) {
    return healDescriptor(policyChoice.descriptor);
  }
  return ctx.profile.providers?.[verb];
}
