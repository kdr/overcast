/**
 * The single persist seam for verb output — CLI, agent tool, and TUI slash all
 * write records through here so the guards (transient / already-persisted /
 * other-case) can't drift, and so finding triggers run on EVERY fresh evidence
 * record: a standalone `face --match` / `image match` / `similar match` /
 * `cluster identify` surfaces a suggested-finding lead exactly like a
 * scan/monitor chain does. Trigger evaluation is best-effort — it must never
 * break the verb's own output.
 */
import type { Case } from "../case.js";
import type { OvercastRecord } from "../record.js";
import { evaluateTriggers, resolveFindingsPolicy } from "../signals/triggers.js";
import { loadSetup } from "../state/setup.js";
import { listTargets } from "../state/target.js";

/** Persist a verb's records into the case store, then run finding triggers over
 *  what was written. Returns any suggested-finding records it appended so the
 *  caller can render them alongside the verb's own output. */
export function persistRecords(c: Case, records: OvercastRecord[], opts: { signals?: boolean } = {}): OvercastRecord[] {
  const persisted: OvercastRecord[] = [];
  for (const rec of records) {
    if (rec.meta?.transient === true || rec.meta?.persisted === true) continue;
    if (rec.meta?.case && rec.meta.case !== c.dir) continue;
    c.writeRecord(rec);
    persisted.push(rec);
  }
  if (opts.signals === false || !persisted.length) return [];
  try {
    // chain-created findings are already in the batch (and now the store), so
    // dedup inside evaluateTriggers keeps this second pass idempotent.
    const suggestions = evaluateTriggers({
      fresh: persisted,
      existing: c.records(),
      targets: listTargets(c),
      policy: resolveFindingsPolicy(loadSetup(c)),
    });
    for (const s of suggestions) c.writeRecord(s);
    return suggestions;
  } catch {
    return [];
  }
}
