/**
 * Case knowledge graph ("connect the dots") — a deterministic structural harvest
 * over the record store. Pure functions over records (no I/O), offline-testable
 * like signals/devices.ts; src/verbs/graph.ts owns files/launching and
 * src/report/graph.ts owns the HTML viewer.
 *
 * Evidence boundary: record nodes come from `memoryRecords()` — IDENTICAL to
 * ask/brief, so operational/meta records, dismissed findings, and unreviewed
 * suggested leads never enter the graph. Entity harvesting reads the SAME text
 * ask/brief index (`indexableDocument`), so raw boxes/vectors/dumps stay out.
 */
import { memoryRecords, recordCaptureTimeMs, recordStub, stripUrlTail, type OvercastRecord } from "../record.js";
import { indexableDocument } from "../providers/memory/fields.js";
import { buildDeviceClusters } from "./devices.js";
import { buildThreads } from "./threads.js";
import { validLat, validLng } from "../geo.js";
import type { TargetEntry } from "../state/target.js";
import type { MergedExtraction } from "../providers/brain/extract.js";

export type GraphNodeType = "record" | "media" | "target" | "finding" | "person" | "device" | "place" | "entity";

export interface GraphNode {
  /** stable id: rec:<id> | media:<ref> | tgt:<id> | fnd:<id> | person:<key> |
   *  dev:<fingerprint> | place:<key> | ent:<type>:<norm> */
  id: string;
  type: GraphNodeType;
  label: string;
  /** owning/provenance record (record + finding nodes) */
  recordId?: string;
  /** media path/url (media nodes) */
  ref?: string;
  /** entity nodes: email | phone | handle | url | domain | hashtag | serial |
   *  person | org | location | username | vehicle | event | other */
  entityType?: string;
  /** mention/member count where meaningful */
  count?: number;
  /** whether any edge on this node came from LLM extraction (lead, not proof) */
  extracted?: boolean;
  degree: number;
  component: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** senses | finding-source | finding-target | note-ref | match | device-member
   *  | mentions | target-evidence | relation (LLM) */
  kind: string;
  label?: string;
  /** provenance record that asserted the link */
  recordId?: string;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  components: number;
  byType: Record<string, number>;
  /** evidence records considered (post --since, pre node trim) */
  evidenceRecords: number;
  /** nodes trimmed away by --limit */
  truncated: number;
}

export interface GraphModel {
  caseName: string;
  caseDir: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface BuildGraphOptions {
  caseName: string;
  caseDir: string;
  /** lines of investigation (from state/target.ts listTargets) */
  targets?: TargetEntry[];
  sinceCutoff?: number;
  /** max nodes; lowest-degree leaf entities trim first (records with findings never) */
  limit?: number;
  /** restrict to the 2-hop neighborhood of the matched node */
  focus?: string;
  /** merged LLM extraction (graph --extract) — entities/relations become
   *  `extracted` nodes + `relation`/`mentions` edges */
  extraction?: MergedExtraction;
  now?: number;
}

// ---- entity harvest ----------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Conservative on purpose: E.164 (+ 7-15 digits, separators allowed), or a
// separator-shaped local number ((xxx) xxx-xxxx / xxx-xxx-xxxx). Bare digit runs,
// timestamps (colon-separated), and dates (4-2-2 shape) never match.
const PHONE_RE = /(?<!\d)(?:\+\d{1,3}[ .-]?\d{2,4}(?:[ .-]\d{2,4}){1,4}|\+\d{7,15}|\(\d{3}\)[ .-]?\d{3}[ .-]\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4})(?!\d)/g;
// @handle — the lookbehind rejects the middle of an email/path.
const HANDLE_RE = /(?<![A-Za-z0-9._%+/-])@[A-Za-z0-9_](?:[A-Za-z0-9_.]{1,29})/g;
const URL_RE = /https?:\/\/[^\s<>"'()\][]+/g;
const HASHTAG_RE = /(?<![&\w#])#[A-Za-z_][A-Za-z0-9_]{1,63}/g;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface HarvestedEntity {
  type: string;
  /** normalized dedup key */
  key: string;
  /** display text */
  label: string;
}

function normEntity(s: string): string {
  return s.trim().toLowerCase();
}

/** Regex-harvest typed entities from one evidence-text blob. */
export function harvestEntities(text: string): HarvestedEntity[] {
  const out = new Map<string, HarvestedEntity>();
  const add = (type: string, raw: string) => {
    const label = raw.trim().replace(/[.,;:]+$/, "");
    if (!label) return;
    const key = `${type}:${normEntity(label)}`;
    if (!out.has(key)) out.set(key, { type, key: normEntity(label), label });
  };
  for (const m of text.match(EMAIL_RE) ?? []) add("email", m);
  // strip emails before the phone/handle passes so an email's digits/@name
  // don't re-harvest as phone/handle fragments.
  const stripped = text.replace(EMAIL_RE, " ");
  for (const m of stripped.match(PHONE_RE) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) add("phone", m);
  }
  for (const m of stripped.match(HANDLE_RE) ?? []) add("handle", m);
  for (const m of text.match(URL_RE) ?? []) {
    add("url", m);
    const host = m.match(/^https?:\/\/([^/:?#]+)/i)?.[1];
    if (host && host.includes(".")) add("domain", host);
  }
  for (const m of text.match(HASHTAG_RE) ?? []) {
    if (!HEX_COLOR_RE.test(m)) add("hashtag", m);
  }
  return [...out.values()];
}

// ---- internals ---------------------------------------------------------------

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? (r.payload as Record<string, unknown>) : {};
}

function arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function baseName(ref: string): string {
  const parts = stripUrlTail(ref).split(/[\\/]/);
  return parts[parts.length - 1] || ref;
}

/** Payload keys that carry identity signal on scan records (person/phone/
 *  username sources) — lifted structurally, one shallow + one array level. */
const IDENTITY_KEY_RE = /^(phone|phones|email|emails|username|usernames|handle|handles|address|addresses|account|accounts|site|sites)$/i;

function liftIdentityStrings(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (!IDENTITY_KEY_RE.test(k)) continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object") {
          for (const inner of Object.values(item as Record<string, unknown>)) {
            if (typeof inner === "string") out.push(inner);
          }
        }
      }
    }
  }
  return out;
}

/** Matched refs a match-verb record links its query media to — the COMPACT
 *  fields only (never boxes/vectors/homographies). */
function matchedRefs(rec: OvercastRecord): Array<{ ref: string; label?: string }> {
  const p = payloadOf(rec);
  const op = str(p.op);
  const out: Array<{ ref: string; label?: string }> = [];
  const seen = new Set<string>();
  const push = (ref: string | undefined, label?: string) => {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    out.push({ ref, label });
  };
  if (rec.verb === "face" && op === "match") {
    const best = arr(p.faces).concat(arr(p.moments)).reduce<number | undefined>((top, f) => {
      const s = typeof f.similarity === "number" ? f.similarity : undefined;
      return s !== undefined && (top === undefined || s > top) ? s : top;
    }, undefined);
    push(str(p.reference), best !== undefined ? `face ${best.toFixed(0)}%` : "face match");
  } else if (rec.verb === "image" && op === "match") {
    for (const m of arr(p.matches)) push(str(m.db_img_path) ?? str(m.ref) ?? str(m.file), typeof m.num_inliers === "number" ? `image ${m.num_inliers} inliers` : "image match");
  } else if (rec.verb === "similar" && (op === "match" || op === "search")) {
    for (const m of arr(p.matches)) push(str(m.ref), typeof m.similarity === "number" ? `similar ${(m.similarity as number).toFixed(0)}%` : "similar");
  } else if (rec.verb === "audio" && op === "match") {
    for (const m of arr(p.matches)) push(str(m.ref), "audio match");
  } else if (rec.verb === "voice" && (op === "match" || op === "search")) {
    push(str(p.reference), "voice reference");
    for (const m of arr(p.matches)) push(str(m.ref), typeof m.similarity === "number" ? `voice ${(m.similarity as number).toFixed(0)}` : "voice match");
  }
  return out;
}

/** Cluster people referenced by an ingest/identify record: [key, label]. */
function clusterPeople(rec: OvercastRecord): Array<{ key: string; label: string }> {
  const p = payloadOf(rec);
  const op = str(p.op);
  const index = str(p.index) ?? "cluster";
  const out = new Map<string, string>();
  if (op === "ingest") {
    for (const f of arr(p.faces)) {
      const cid = str(f.cluster_id);
      if (cid) out.set(`${index}/${cid}`, str(f.label) ?? cid);
    }
  } else if (op === "identify") {
    for (const m of arr(p.matches)) {
      const top = arr(m.candidates)[0];
      const cid = top ? str(top.cluster_id) : undefined;
      if (cid && (m.confident === undefined || m.confident === true)) out.set(`${index}/${cid}`, str(top!.label) ?? cid);
    }
  }
  return [...out.entries()].map(([key, label]) => ({ key, label }));
}

interface Builder {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  edgeSeen: Set<string>;
}

function addNode(b: Builder, node: Omit<GraphNode, "degree" | "component">): GraphNode {
  const existing = b.nodes.get(node.id);
  if (existing) {
    if (node.count) existing.count = (existing.count ?? 0) + node.count;
    if (node.extracted) existing.extracted = true;
    return existing;
  }
  const created: GraphNode = { ...node, degree: 0, component: -1 };
  b.nodes.set(node.id, created);
  return created;
}

function addEdge(b: Builder, edge: GraphEdge): void {
  if (!b.nodes.has(edge.source) || !b.nodes.has(edge.target)) return;
  if (edge.source === edge.target) return;
  // undirected dedup per kind (keep the first provenance)
  const [a, z] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
  const key = `${a}\0${z}\0${edge.kind}\0${edge.label ?? ""}`;
  if (b.edgeSeen.has(key)) return;
  b.edgeSeen.add(key);
  b.edges.push(edge);
}

function computeDegrees(nodes: Map<string, GraphNode>, edges: GraphEdge[]): void {
  for (const n of nodes.values()) n.degree = 0;
  for (const e of edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (s) s.degree++;
    if (t) t.degree++;
  }
}

/** Hand-rolled connected components (BFS over the undirected adjacency). */
function computeComponents(nodes: Map<string, GraphNode>, edges: GraphEdge[]): number {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  let comp = 0;
  for (const start of nodes.keys()) {
    if (nodes.get(start)!.component !== -1) continue;
    const queue = [start];
    nodes.get(start)!.component = comp;
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adj.get(cur) ?? []) {
        const n = nodes.get(next);
        if (n && n.component === -1) {
          n.component = comp;
          queue.push(next);
        }
      }
    }
    comp++;
  }
  return comp;
}

/** k-hop (k=2) neighborhood of the focused node. Match order: exact node id,
 *  record id, media ref/basename, then case-insensitive label/entity substring.
 *  Returns the matched anchor id too — --limit must never trim it. */
function focusSubgraph(nodes: Map<string, GraphNode>, edges: GraphEdge[], focus: string): { anchorId: string; keep: Set<string> } | undefined {
  const needle = focus.trim().toLowerCase();
  if (!needle) return undefined;
  const all = [...nodes.values()];
  const hit =
    nodes.get(focus) ??
    all.find((n) => n.recordId === focus) ??
    all.find((n) => n.ref === focus || (n.ref && baseName(n.ref).toLowerCase() === needle)) ??
    all.find((n) => n.label.toLowerCase() === needle) ??
    all.find((n) => n.label.toLowerCase().includes(needle));
  if (!hit) return undefined;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  const keep = new Set<string>([hit.id]);
  let frontier = [hit.id];
  for (let hop = 0; hop < 2; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!keep.has(n)) {
          keep.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return { anchorId: hit.id, keep };
}

// ---- the builder ---------------------------------------------------------------

/** The graph's evidence selection — the memoryRecords (ask/brief) boundary,
 *  then --since (capture-aware like map, keep-undated like map/wall), then
 *  finding-source co-inclusion: an in-window finding pulls its out-of-window
 *  source record back in — a finding restates its source, so orphaning it from
 *  its provenance would misread as an unsourced claim. Exported so
 *  `runExtraction` (graph --extract) reads the IDENTICAL corpus the board
 *  shows — anything less and extracted entities float without mention edges. */
export function selectGraphEvidence(records: OvercastRecord[], sinceCutoff?: number): { plain: OvercastRecord[]; findings: OvercastRecord[] } {
  const evidenceAll = memoryRecords(records);
  let evidence = evidenceAll;
  if (sinceCutoff != null) {
    evidence = evidence.filter((r) => {
      const t = recordCaptureTimeMs(r);
      return Number.isNaN(t) || t >= sinceCutoff;
    });
  }
  const findings = evidence.filter((r) => r.verb === "finding");
  const plain = evidence.filter((r) => r.verb !== "finding");
  if (sinceCutoff != null && findings.length) {
    const plainIds = new Set(plain.map((r) => r.id));
    const byId = new Map(evidenceAll.filter((r) => r.verb !== "finding").map((r) => [r.id, r]));
    for (const f of findings) {
      const src = str(payloadOf(f).source_record);
      if (!src || plainIds.has(src)) continue;
      const source = byId.get(src);
      if (source) {
        plain.push(source);
        plainIds.add(src);
      }
    }
  }
  return { plain, findings };
}

/** Build the case knowledge graph from raw case records. Pure — records come
 *  from `ctx.case.records()`, targets from `listTargets`; no I/O here. */
export function buildGraphModel(records: OvercastRecord[], opts: BuildGraphOptions): GraphModel {
  const b: Builder = { nodes: new Map(), edges: [], edgeSeen: new Set() };
  const targets = opts.targets ?? [];

  const { plain, findings } = selectGraphEvidence(records, opts.sinceCutoff);

  // record + media nodes, record→media edges
  for (const rec of plain) {
    addNode(b, { id: `rec:${rec.id}`, type: "record", label: `${rec.verb}: ${recordStub(rec, 60)}`, recordId: rec.id });
    if (rec.media?.ref) {
      addNode(b, { id: `media:${rec.media.ref}`, type: "media", label: baseName(rec.media.ref), ref: rec.media.ref });
      addEdge(b, { source: `rec:${rec.id}`, target: `media:${rec.media.ref}`, kind: "senses", recordId: rec.id });
    }
  }

  // finding nodes (accepted/open — memoryRecords already quarantined the rest)
  for (const f of findings) {
    const p = payloadOf(f);
    addNode(b, { id: `fnd:${f.id}`, type: "finding", label: str(p.text)?.slice(0, 80) ?? `finding ${f.id}`, recordId: f.id });
    const src = str(p.source_record);
    if (src && b.nodes.has(`rec:${src}`)) addEdge(b, { source: `fnd:${f.id}`, target: `rec:${src}`, kind: "finding-source", recordId: f.id });
  }

  // target nodes
  for (const t of targets) {
    addNode(b, { id: `tgt:${t.id}`, type: "target", label: t.value.slice(0, 80) });
  }
  // finding→target via stamped target_id
  for (const f of findings) {
    const tid = str(payloadOf(f).target_id);
    if (tid) addEdge(b, { source: `fnd:${f.id}`, target: `tgt:${tid}`, kind: "finding-target", recordId: f.id });
  }

  // note→record via related_record / ref
  for (const rec of plain) {
    if (rec.verb !== "note") continue;
    const p = payloadOf(rec);
    const related = str(p.related_record);
    if (related && b.nodes.has(`rec:${related}`)) {
      addEdge(b, { source: `rec:${rec.id}`, target: `rec:${related}`, kind: "note-ref", recordId: rec.id });
    } else {
      const ref = str(p.ref);
      if (ref && b.nodes.has(`media:${ref}`)) addEdge(b, { source: `rec:${rec.id}`, target: `media:${ref}`, kind: "note-ref", recordId: rec.id });
    }
  }

  // match-verb links: query media ↔ matched media (through the match record)
  for (const rec of plain) {
    for (const m of matchedRefs(rec)) {
      addNode(b, { id: `media:${m.ref}`, type: "media", label: baseName(m.ref), ref: m.ref });
      addEdge(b, { source: `rec:${rec.id}`, target: `media:${m.ref}`, kind: "match", label: m.label, recordId: rec.id });
    }
  }

  // person nodes from cluster ingest/identify
  for (const rec of plain) {
    if (rec.verb !== "cluster") continue;
    for (const person of clusterPeople(rec)) {
      addNode(b, { id: `person:${person.key}`, type: "person", label: person.label });
      addEdge(b, { source: `person:${person.key}`, target: `rec:${rec.id}`, kind: "match", label: "face cluster", recordId: rec.id });
    }
  }

  // device nodes via the shared exif fingerprint rollup
  const rollup = buildDeviceClusters(plain);
  for (const cluster of rollup.clusters) {
    const device = [cluster.make, cluster.model].filter(Boolean).join(" ") || cluster.fingerprint;
    addNode(b, {
      id: `dev:${cluster.fingerprint}`,
      type: "device",
      label: cluster.serial ? `${device} (serial ${cluster.serial})` : device,
      count: cluster.count,
    });
    for (const member of cluster.members) {
      if (b.nodes.has(`rec:${member.recordId}`)) {
        addEdge(b, { source: `dev:${cluster.fingerprint}`, target: `rec:${member.recordId}`, kind: "device-member", recordId: member.recordId });
      }
    }
  }
  const clusteredSerials = new Set(rollup.clusters.map((c) => c.serial?.toLowerCase()).filter(Boolean));

  // place nodes: payload.place strings, else coarse GPS buckets (~1km, 2 dp)
  for (const rec of plain) {
    const p = payloadOf(rec);
    const place = str(p.place);
    const gps = p.gps && typeof p.gps === "object" ? (p.gps as Record<string, unknown>) : undefined;
    const lat = gps ? validLat(gps.lat) : undefined;
    const lng = gps ? validLng(gps.lng) : undefined;
    let key: string | undefined;
    let label: string | undefined;
    if (place) {
      key = `name:${normEntity(place)}`;
      label = place;
    } else if (lat !== undefined && lng !== undefined) {
      key = `gps:${lat.toFixed(2)},${lng.toFixed(2)}`;
      label = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
    if (!key || !label) continue;
    addNode(b, { id: `place:${key}`, type: "place", label });
    addEdge(b, { source: `rec:${rec.id}`, target: `place:${key}`, kind: "mentions", label: "located at", recordId: rec.id });
  }

  // entity harvest over the SAME text ask/brief index + structural lifts
  for (const rec of plain) {
    const found: HarvestedEntity[] = [];
    const doc = indexableDocument(rec);
    if (doc) found.push(...harvestEntities(doc.text));
    const p = payloadOf(rec);
    // structural lifts: exif serial (only when no device cluster already covers
    // it — otherwise it would duplicate the device node), scan handle/identity
    // payload fields.
    if (rec.verb === "exif") {
      const serial = str(p.serial);
      if (serial && !clusteredSerials.has(serial.toLowerCase())) found.push({ type: "serial", key: normEntity(serial), label: serial });
    }
    if (rec.verb === "scan") {
      const handle = str(p.handle) ?? str(p.author) ?? str(p.username);
      if (handle) found.push({ type: "handle", key: normEntity(handle), label: handle });
      for (const lifted of liftIdentityStrings(p)) found.push(...harvestEntities(lifted));
    }
    const seen = new Set<string>();
    for (const ent of found) {
      const id = `ent:${ent.type}:${ent.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      addNode(b, { id, type: "entity", label: ent.label, entityType: ent.type, count: 1 });
      addEdge(b, { source: id, target: `rec:${rec.id}`, kind: "mentions", recordId: rec.id });
    }
  }

  // target↔evidence via the SHARED 5-priority thread matcher (brief/status)
  if (targets.length) {
    const threads = buildThreads(records, targets, opts.now ?? Date.now());
    for (const thread of threads) {
      for (const rid of thread.recentEvidenceIds) {
        if (b.nodes.has(`rec:${rid}`)) addEdge(b, { source: `tgt:${thread.id}`, target: `rec:${rid}`, kind: "target-evidence" });
      }
      for (const fid of thread.findingIds) {
        if (b.nodes.has(`fnd:${fid}`)) addEdge(b, { source: `tgt:${thread.id}`, target: `fnd:${fid}`, kind: "finding-target" });
      }
    }
  }

  // LLM extraction merge (graph --extract): normalized entities fold into the
  // regex-harvested nodes when type+name coincide; relations link entity↔entity.
  if (opts.extraction) {
    for (const ent of opts.extraction.entities) {
      const id = `ent:${ent.type}:${ent.key}`;
      addNode(b, { id, type: "entity", label: ent.label, entityType: ent.type, extracted: true });
      for (const rid of ent.recordIds) {
        if (b.nodes.has(`rec:${rid}`)) addEdge(b, { source: id, target: `rec:${rid}`, kind: "mentions", recordId: rid });
      }
    }
    for (const rel of opts.extraction.relations) {
      const src = `ent:${rel.sourceType}:${rel.sourceKey}`;
      const dst = `ent:${rel.targetType}:${rel.targetKey}`;
      addEdge(b, { source: src, target: dst, kind: "relation", label: rel.relation, recordId: rel.recordId });
    }
  }

  computeDegrees(b.nodes, b.edges);

  // --focus: 2-hop neighborhood of the matched node. A miss empties the graph
  // (the verb turns that into pending guidance) rather than silently showing
  // the full, unfocused graph.
  let focusAnchorId: string | undefined;
  if (opts.focus) {
    const sub = focusSubgraph(b.nodes, b.edges, opts.focus);
    const keep = sub?.keep ?? new Set<string>();
    focusAnchorId = sub?.anchorId;
    for (const id of [...b.nodes.keys()]) if (!keep.has(id)) b.nodes.delete(id);
    b.edges = b.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    computeDegrees(b.nodes, b.edges);
  }

  // --limit: trim lowest-degree leaf ENTITY nodes first, then places, then
  // orphan media — NEVER records with findings, targets, findings, persons,
  // devices, or the --focus anchor (trimming the node the user asked for
  // would defeat the focus).
  let truncated = 0;
  const limit = opts.limit != null && opts.limit > 0 ? Math.floor(opts.limit) : undefined;
  if (limit !== undefined && b.nodes.size > limit) {
    const findingLinked = new Set<string>();
    for (const e of b.edges) {
      if (e.kind === "finding-source") {
        findingLinked.add(e.source);
        findingLinked.add(e.target);
      }
    }
    const trimRank = (n: GraphNode): number => {
      if (n.id === focusAnchorId) return Infinity; // protected
      if (n.type === "entity") return 0;
      if (n.type === "place") return 1;
      if (n.type === "media" && n.degree <= 1) return 2;
      if (n.type === "record" && !findingLinked.has(n.id)) return 3;
      return Infinity; // protected
    };
    const candidates = [...b.nodes.values()]
      .filter((n) => trimRank(n) !== Infinity)
      .sort((a, z) => trimRank(a) - trimRank(z) || a.degree - z.degree);
    for (const victim of candidates) {
      if (b.nodes.size <= limit) break;
      b.nodes.delete(victim.id);
      truncated++;
    }
    b.edges = b.edges.filter((e) => b.nodes.has(e.source) && b.nodes.has(e.target));
    computeDegrees(b.nodes, b.edges);
  }

  const components = computeComponents(b.nodes, b.edges);
  const byType: Record<string, number> = {};
  for (const n of b.nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;

  return {
    caseName: opts.caseName,
    caseDir: opts.caseDir,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    nodes: [...b.nodes.values()],
    edges: b.edges,
    stats: {
      nodes: b.nodes.size,
      edges: b.edges.length,
      components,
      byType,
      evidenceRecords: plain.length + findings.length,
      truncated,
    },
  };
}
