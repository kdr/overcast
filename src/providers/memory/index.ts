// Memory fan-out (A-spec): ask/brief read across all bound case-search providers
// and merge. local-grep is always present; profiles can opt into qmd.

import type { Case } from "../../case.js";
import type { Profile } from "../../profile.js";
import type { MemoryProvider, Answer, QueryOpts, Citation } from "./types.js";
import { LocalMemoryProvider } from "./local.js";
import { QmdMemoryProvider } from "./qmd.js";

/** Resolve the bound memory providers for a case. local-grep is always present. */
export function resolveMemory(case_: Case, profile?: Profile): MemoryProvider[] {
  const providers: MemoryProvider[] = [new LocalMemoryProvider(case_)];
  for (const spec of profile?.memory ?? []) {
    const backend = (spec.backend ?? spec.id ?? "").toLowerCase();
    if (backend === "qmd") {
      providers.push(new QmdMemoryProvider(case_, {
        id: spec.id,
        command: spec.command ?? spec.run,
        collection: spec.collection,
        model: spec.model,
        clearTemplate: spec.clearTemplate,
        indexTemplate: spec.indexTemplate,
        embedTemplate: spec.embedTemplate,
        queryTemplate: spec.queryTemplate,
      }));
    }
  }
  return providers;
}

export function matchesMemoryProvider(p: MemoryProvider, id: string): boolean {
  return p.id === id || p.backend === id || (p.aliases ?? []).includes(id);
}

function citationKey(c: Citation): string {
  const at = Array.isArray(c.at) ? c.at.join("-") : c.at ?? "";
  return JSON.stringify([c.recordId, c.verb, at, c.field ?? "", c.text ?? ""]);
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
      if (p.status) {
        const st = await p.status();
        if (st.state !== "ready") {
          const reason = st.state === "error" && st.error ? `: ${st.error}` : "";
          throw new Error(
            `${p.id} index is ${st.state}${reason}; run ` +
              `\`overcast case memory index rebuild --memory ${p.id}\` before querying semantic memory.`,
          );
        }
      }
      const passages = await p.deepsearch(q, opts);
      a = passages.length === 0 && p.answer
        ? await p.answer(q, opts)
        : {
            text: passages.map((x) => `- [${x.recordId}] ${x.text}`).join("\n"),
            citations: passages.map((x) => ({ recordId: x.recordId, at: x.at, verb: x.verb, field: x.field, text: x.text })),
          };
    } else if (p.answer) {
      a = await p.answer(q, opts);
    } else {
      const passages = await p.query(q, opts);
      a = {
        text: passages.map((x) => `- [${x.recordId}] ${x.text}`).join("\n"),
        citations: passages.map((x) => ({ recordId: x.recordId, at: x.at, verb: x.verb, field: x.field, text: x.text })),
      };
    }
    if (a.text.trim()) texts.push(providers.length > 1 ? `## ${p.id}\n${a.text}` : a.text);
    for (const c of a.citations) {
      const key = citationKey(c);
      if (!seen.has(key)) {
        seen.add(key);
        citations.push(c);
      }
    }
  }
  return { text: texts.join("\n\n") || `No records match "${q}".`, citations };
}
