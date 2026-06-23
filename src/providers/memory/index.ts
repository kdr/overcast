// Memory fan-out (A-spec): ask/brief read across all bound memory providers and
// merge. v1 binds only the always-on local provider (B-first); Phase 5 adds the
// cloudglue provider. The fan-out interface already accepts >1 provider.

import type { Case } from "../../case.js";
import type { Profile } from "../../profile.js";
import type { MemoryProvider, Passage, Answer, QueryOpts, Citation } from "./types.js";
import { LocalMemoryProvider } from "./local.js";

/** Resolve the bound memory providers for a case. Local is always present. */
export function resolveMemory(case_: Case, _profile?: Profile): MemoryProvider[] {
  const providers: MemoryProvider[] = [new LocalMemoryProvider(case_)];
  // Phase 5: append a cloudglue memory provider when bound in the profile.
  return providers;
}

/** Fan out a query across providers and merge passages (dedup by record id). */
export async function fanOutQuery(
  providers: MemoryProvider[],
  q: string,
  opts?: QueryOpts,
  deep = false,
): Promise<Passage[]> {
  const all: Passage[] = [];
  for (const p of providers) {
    const fn = deep && p.deepsearch ? p.deepsearch.bind(p) : p.query.bind(p);
    all.push(...(await fn(q, opts)));
  }
  // dedup by recordId, keeping the highest score
  const byId = new Map<string, Passage>();
  for (const p of all) {
    const cur = byId.get(p.recordId);
    if (!cur || p.score > cur.score) byId.set(p.recordId, p);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, opts?.limit ?? 8);
}

/**
 * Fan out an answer across providers, preferring grounded/cited results. v1
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
    if (p.answer) {
      a = await p.answer(q, opts);
    } else {
      const passages = deep && p.deepsearch ? await p.deepsearch(q, opts) : await p.query(q, opts);
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
