// Memory fan-out (A-spec): ask/brief read across all bound memory providers and
// merge. currently binds only the always-on local provider; later work adds the
// cloudglue provider. The fan-out interface already accepts >1 provider.

import type { Case } from "../../case.js";
import type { Profile } from "../../profile.js";
import type { MemoryProvider, Answer, QueryOpts, Citation } from "./types.js";
import { LocalMemoryProvider } from "./local.js";

/** Resolve the bound memory providers for a case. Local is always present. */
export function resolveMemory(case_: Case, _profile?: Profile): MemoryProvider[] {
  const providers: MemoryProvider[] = [new LocalMemoryProvider(case_)];
  // append a cloudglue memory provider when bound in the profile.
  return providers;
}

/**
 * Fan out an answer across providers, preferring grounded/cited results. Currently
 * merges by taking each provider's `answer` (or synthesizing from query) and
 * concatenating with a deduped citation set.
 */
export async function fanOutAnswer(
  providers: MemoryProvider[],
  q: string,
  opts?: QueryOpts,
  deep = false,
): Promise<Answer> {
  const texts: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    let a: Answer;
    // --deep engages agentic semantic search where a provider implements it,
    // even if it also has a plain `answer` (otherwise deepsearch is unreachable).
    if (deep && p.deepsearch) {
      const passages = await p.deepsearch(q, opts);
      a = {
        text: passages.map((x) => `- [${x.recordId}] ${x.text}`).join("\n"),
        citations: passages.map((x) => ({ recordId: x.recordId, at: x.at, verb: x.verb })),
      };
    } else if (p.answer) {
      a = await p.answer(q, opts);
    } else {
      const passages = await p.query(q, opts);
      a = {
        text: passages.map((x) => `- [${x.recordId}] ${x.text}`).join("\n"),
        citations: passages.map((x) => ({ recordId: x.recordId, at: x.at, verb: x.verb })),
      };
    }
    if (a.text.trim()) texts.push(providers.length > 1 ? `## ${p.id}\n${a.text}` : a.text);
    for (const c of a.citations) {
      const key = `${c.recordId}:${Array.isArray(c.at) ? c.at.join("-") : c.at ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        citations.push(c);
      }
    }
  }
  return { text: texts.join("\n\n") || `No records match "${q}".`, citations };
}
