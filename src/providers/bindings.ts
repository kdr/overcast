import { loadSetup } from "../state/setup.js";
import { findProviderChoice } from "./catalog.js";
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
  if (policy?.choice && findProviderChoice(verb, policy.choice)?.clearsBinding === true) return undefined;
  const profileDescriptor = ctx.profile.providers?.[verb];
  if (isProviderDescriptor(profileDescriptor)) return profileDescriptor;
  const descriptor = policy?.descriptor;
  if (isProviderDescriptor(descriptor)) return descriptor;
  return ctx.profile.providers?.[verb];
}
