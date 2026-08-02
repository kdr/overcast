// Memory fan-out (A-spec): ask/brief read across all bound case-search providers
// and merge. local-grep is always present; profiles can opt into qmd.

import type { Case } from "../../case.js";
import { resolveCloudglue, type Profile } from "../../profile.js";
import type { MemoryProvider, Answer, QueryOpts, Citation } from "./types.js";
import { LocalMemoryProvider } from "./local.js";
import { QmdMemoryProvider } from "./qmd.js";
import { CloudglueMemoryProvider } from "./cloudglue.js";
import { loadSetup } from "../../state/setup.js";
import { indexesByType, resolveIndexRef } from "../../state/index.js";
import { tinycloudBaseFromRun } from "../tinycloud/envelope.js";
import { providerEnv } from "../provider-env.js";

/** Resolve the case's opt-in Cloudglue collection ref, if any. A pinned
 *  `memory.cloudglue.index` (id / unique name) must be a media-descriptions
 *  index; otherwise the case's first attached media-descriptions index is used.
 *  Returns undefined when nothing ask-able is linked. */
function resolveCloudglueCollection(case_: Case, pinned?: string): { indexId: string; collectionId: string } | undefined {
  const want = pinned?.trim();
  if (want) {
    const ref = resolveIndexRef(case_, want);
    // Fail CLOSED on an ambiguous pinned name (matches >1 mirror index): treating
    // it as a raw remote id could silently query the WRONG collection. Return
    // undefined so cloudglue isn't registered — mirroring how `ask --index`
    // errors on ambiguity (src/verbs/read.ts). Only a value that is truly not in
    // the mirror ({} — no entry AND no error) may map to a raw remote id.
    if (ref.error) return undefined;
    if (!ref.entry) return { indexId: want, collectionId: want }; // unmirrored → raw remote id
    // Mirror `ask --index` (src/verbs/read.ts): accept a media-descriptions index
    // OR an untyped ("unknown") mirror entry — one added by raw id without --type
    // stays "unknown" yet is still a valid ask/probe target. Only OTHER concrete
    // types (face-analysis, entities, …) are rejected. Being stricter than
    // `ask --index` here would make the deep tier unable to use an index that
    // `ask --index` already answers over.
    if (ref.entry.type !== "media-descriptions" && ref.entry.type !== "unknown") return undefined;
    return { indexId: ref.entry.id, collectionId: ref.entry.id };
  }
  const attached = indexesByType(case_, "media-descriptions")[0];
  return attached ? { indexId: attached.id, collectionId: attached.id } : undefined;
}

/** Resolve the bound memory providers for a case. local-grep is always present.
 *  `opts.deep` requests the cloud tier (the opt-in Cloudglue collection provider)
 *  — it is NEVER added for a plain (non-deep) resolution, so a default `ask` can't
 *  silently spend against the collection. `opts.signal` (the command's AbortSignal)
 *  is threaded to the cloud provider so a canceled/timed-out `ask --deep` aborts the
 *  paid tinycloud query instead of leaving it running. */
export function resolveMemory(case_: Case, profile?: Profile, opts: { deep?: boolean; signal?: AbortSignal } = {}): MemoryProvider[] {
  const setup = loadSetup(case_);
  const setupMemory = setup?.memory;
  const signalSet = new Set(setupMemory?.signals ?? []);
  for (const [verb, policy] of Object.entries(setup?.providers ?? {})) {
    if (policy.indexable === true) signalSet.add(verb);
  }
  const verbs = signalSet.size ? [...signalSet] : undefined;
  const providers: MemoryProvider[] = [new LocalMemoryProvider(case_, { verbs })];
  let hasQmd = false;
  if (!setupMemory || setupMemory.backend === "qmd") {
    for (const spec of profile?.memory ?? []) {
      const backend = (spec.backend ?? spec.id ?? "").toLowerCase();
      if (backend === "qmd") {
        hasQmd = true;
        providers.push(new QmdMemoryProvider(case_, {
          id: spec.id,
          command: spec.command ?? spec.run,
          collection: spec.collection,
          model: spec.model,
          verbs,
          clearTemplate: spec.clearTemplate,
          indexTemplate: spec.indexTemplate,
          embedTemplate: spec.embedTemplate,
          queryTemplate: spec.queryTemplate,
        }));
      }
    }
  }
  if (setupMemory?.backend === "qmd" && !hasQmd) providers.push(new QmdMemoryProvider(case_, { verbs }));

  // Cloud tier (opt-in, deep-only). Registered ONLY when all hold: `ask --deep`
  // was requested (opts.deep), the operator opted in (setup.memory.cloudglue), a
  // media-descriptions collection resolves, AND a Cloudglue key is present — so a
  // plain `ask` never sees this provider (no silent spend) and it is unreachable
  // unless explicitly asked for. Invariant #9: it queries via the public tinycloud
  // ask verb (collection.ts / tcAsk), never the Cloudglue SDK.
  if (opts.deep && setupMemory?.cloudglue) {
    const apiKey = resolveCloudglue().apiKey;
    const ref = apiKey ? resolveCloudglueCollection(case_, setupMemory.cloudglue.index) : undefined;
    if (apiKey && ref) {
      providers.push(
        new CloudglueMemoryProvider(case_, {
          indexId: ref.indexId,
          collectionId: ref.collectionId,
          base: tinycloudBaseFromRun(profile?.providers?.index?.run ?? profile?.providers?.collection?.run),
          env: providerEnv(case_.mediaDir, case_.dir),
          // thread the command's AbortSignal so a canceled/timed-out deep ask
          // aborts the paid tinycloud query (parity with `ask --index`).
          signal: opts.signal,
        }),
      );
    } else {
      // The operator opted into the cloud tier and asked for `--deep`, but it
      // couldn't activate. `resolveMemory` returns a provider list (not records),
      // so a stderr note is the right channel to say WHY the tier is silent —
      // otherwise `ask --deep` prints the misleading qmd-only "no semantic memory
      // provider" message, misstating a cloudglue-only setup. Gated on opts.deep
      // (this whole block), so non-deep callers stay silent.
      const pinned = setupMemory.cloudglue.index?.trim();
      const why = !apiKey
        ? "no Cloudglue key (set CLOUDGLUE_API_KEY, or `overcast setup memory cloudglue off` to opt out)"
        : pinned
          ? `no resolvable media-descriptions collection for pinned index '${pinned}' (missing, not a media-descriptions index, or an ambiguous name)`
          : "no media-descriptions index attached to this case (attach one, or pin it with `overcast setup memory cloudglue <index>`)";
      process.stderr.write(`overcast: ask --deep Cloudglue cloud tier inactive — ${why}\n`);
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
          // qmd uses `building` for both an active rebuild and an interrupted
          // PARTIAL index; its status error carries the distinction + recovery
          // hint. Surface any provider-supplied reason, not only state=error.
          const reason = st.error ? `: ${st.error}` : "";
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
