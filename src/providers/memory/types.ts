// Memory provider interface (CLAUDE.md invariant #6, memory class). The spec is
// multi-provider (A-spec); currently ships a single local provider with the
// fan-out interface already in place. `ask`/`brief` read through bound providers;
// every verb's record is written to memory.

import type { OvercastRecord } from "../../record.js";

export interface Passage {
  recordId: string;
  /** media anchor for the citation, if any */
  at?: number | [number, number];
  /** the cited text snippet */
  text: string;
  /** retrieval score (higher = more relevant) */
  score: number;
  verb: string;
  field?: string;
  provider?: string;
}

export interface Citation {
  recordId: string;
  at?: number | [number, number];
  verb: string;
  /** optional source field when a provider returns field-level passages */
  field?: string;
  /** optional cited snippet, used to keep distinct same-record hits separate */
  text?: string;
}

export interface Answer {
  text: string;
  citations: Citation[];
}

export interface QueryOpts {
  limit?: number;
  /** restrict to record verbs/kinds */
  verbs?: string[];
  /** time filter (ISO or relative); applied to meta.time when present */
  since?: string;
}

export interface MemoryIndexStatus {
  provider: string;
  backend: string;
  state: "ready" | "missing" | "stale" | "building" | "error" | string;
  documents?: number;
  records?: number;
  path?: string;
  model?: string;
  config?: Record<string, unknown>;
  error?: string;
  updated?: string;
}

export interface MemoryProvider {
  readonly id: string;
  readonly backend?: string;
  readonly aliases?: string[];
  /** persist/index a record (called automatically after every verb). */
  write(record: OvercastRecord): void | Promise<void>;
  /** retrieval for ask/recall/brief. */
  query(q: string, opts?: QueryOpts): Passage[] | Promise<Passage[]>;
  /** optional grounded NL answer (else ask synthesizes from passages). */
  answer?(q: string, opts?: QueryOpts): Answer | Promise<Answer>;
  /** optional agentic semantic search (ask --deep). */
  deepsearch?(q: string, opts?: QueryOpts): Passage[] | Promise<Passage[]>;
  /** optional materialized-index lifecycle. */
  status?(): MemoryIndexStatus | Promise<MemoryIndexStatus>;
  rebuild?(): MemoryIndexStatus | Promise<MemoryIndexStatus>;
  clear?(): MemoryIndexStatus | Promise<MemoryIndexStatus>;
}
