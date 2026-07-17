// Record detail view. Rendered into an editor-tab webview by
// src/panels/recordPanel.ts. Returns the handler for subsequent host messages
// (field pages arrive via {type:"fieldPage"}; failures via {type:"error"}).
//
// Layout (payload-first — media never dominates):
//   header badges → COLLAPSIBLE capped media → collapsible payload fields →
//   collapsible raw manifest.
// Each field is a two-way collapsible. On expand the full value is paged in from
// the host (`case memory get <id> --field … --offset … --limit …`) and rendered
// by type: object/array → a foldable JSON tree, markdown-ish strings → foldable
// heading sections, other long strings → a scrollable pre with incremental
// "Show more". Loaded content is cached so re-expanding is instant.
import type {
  FieldInfo,
  HostMsg,
  RecordViewState,
} from "../../../src/shared/protocol.ts";
import { mdToHtml } from "./markdown.ts";
import { post } from "../vscodeApi.ts";

const PAGE_CHARS = 8000; // per host round-trip
const INLINE_PREVIEW_CHARS = 200; // scalars/short strings shown without expanding
const LOAD_ALL_MAX = 500_000; // above this, strings/objects fall back to paged pre

interface Manifestish {
  record?: string;
  verb?: string;
  state?: string;
  media?: { ref?: string; at?: string };
}

// Routes fieldPage/error messages to whichever field is currently loading.
type PageHandler = (msg: Extract<HostMsg, { type: "fieldPage" }>) => void;
const pageHandlers = new Map<string, PageHandler>();
const errorHandlers = new Map<string, (message: string) => void>();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text: string, extra?: string): HTMLElement {
  return el("span", extra ? `badge ${extra}` : "badge", text);
}

function chevron(open: boolean): HTMLElement {
  const c = el("span", open ? "chevron open" : "chevron", "▸");
  return c;
}

/** A clickable header + toggled body. onFirstOpen fires once, lazily. */
function collapsible(opts: {
  headChildren: HTMLElement[];
  open?: boolean;
  onFirstOpen?: (body: HTMLElement) => void;
}): HTMLElement {
  const card = el("div", "card");
  const head = el("div", "collapse-head");
  const chev = chevron(!!opts.open);
  head.appendChild(chev);
  for (const c of opts.headChildren) head.appendChild(c);
  const body = el("div", "collapse-body");
  body.hidden = !opts.open;
  let opened = false;
  const maybeFirstOpen = () => {
    if (!opened) {
      opened = true;
      opts.onFirstOpen?.(body);
    }
  };
  if (opts.open) maybeFirstOpen();
  head.addEventListener("click", () => {
    const nextOpen = !!body.hidden;
    body.hidden = !nextOpen;
    chev.classList.toggle("open", nextOpen);
    if (nextOpen) maybeFirstOpen();
  });
  card.appendChild(head);
  card.appendChild(body);
  return card;
}

// ---- paged field loader ----------------------------------------------------

/** Accumulate a field's full text across host round-trips, then hand it over. */
function loadFullField(
  recordId: string,
  field: string,
  onDone: (text: string) => void,
  onError: (message: string) => void,
): void {
  let buffer = "";
  const request = (offset: number) =>
    post({ type: "getField", recordId, field, offset, limit: PAGE_CHARS });
  pageHandlers.set(field, (msg) => {
    buffer += msg.text;
    const next = msg.offset + msg.text.length;
    if (msg.hasMore && buffer.length < LOAD_ALL_MAX) {
      request(next);
    } else {
      pageHandlers.delete(field);
      errorHandlers.delete(field);
      onDone(buffer);
    }
  });
  errorHandlers.set(field, (message) => {
    pageHandlers.delete(field);
    errorHandlers.delete(field);
    onError(message);
  });
  request(0);
}

/** One page at a time with a "Show more" button (for very large plain text). */
function pagedText(recordId: string, field: string, total: number, host: HTMLElement): void {
  const pre = el("pre", "field-pre");
  host.appendChild(pre);
  const more = el("button", "secondary field-more", "Show more");
  const status = el("div", "muted");
  host.appendChild(more);
  host.appendChild(status);
  let offset = 0;
  const request = () => {
    more.disabled = true;
    more.textContent = "Loading…";
    post({ type: "getField", recordId, field, offset, limit: PAGE_CHARS });
  };
  pageHandlers.set(field, (msg) => {
    pre.textContent = (pre.textContent ?? "") + msg.text;
    offset = msg.offset + msg.text.length;
    if (msg.hasMore) {
      more.disabled = false;
      more.textContent = `Show more (${offset}/${total || msg.total})`;
    } else {
      more.remove();
      status.remove();
      pageHandlers.delete(field);
      errorHandlers.delete(field);
    }
  });
  errorHandlers.set(field, (message) => {
    more.disabled = false;
    more.textContent = "Retry";
    status.className = "err-line";
    status.textContent = `⚠ ${message}`;
  });
  more.addEventListener("click", request);
  request();
}

// ---- JSON tree -------------------------------------------------------------

function scalarSpan(value: unknown): HTMLElement {
  if (value === null) return el("span", "tok-null", "null");
  switch (typeof value) {
    case "string":
      return el("span", "tok-string", JSON.stringify(value));
    case "number":
      return el("span", "tok-number", String(value));
    case "boolean":
      return el("span", "tok-boolean", String(value));
    default:
      return el("span", undefined, String(value));
  }
}

function jsonNode(key: string | null, value: unknown, depth: number): HTMLElement {
  const node = el("div", "json-node");
  const isArray = Array.isArray(value);
  const isObject = !isArray && value !== null && typeof value === "object";

  if (!isArray && !isObject) {
    const row = el("div", "json-row");
    if (key !== null) {
      row.appendChild(el("span", "json-key", JSON.stringify(key)));
      row.appendChild(el("span", "tok-punct", ": "));
    }
    row.appendChild(scalarSpan(value));
    node.appendChild(row);
    return node;
  }

  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const openChar = isArray ? "[" : "{";
  const closeChar = isArray ? "]" : "}";
  const summary = isArray ? `${entries.length} items` : `${entries.length} keys`;

  const startOpen = depth < 1;
  const row = el("div", "json-row clickable");
  const chev = chevron(startOpen);
  row.appendChild(chev);
  if (key !== null) {
    row.appendChild(el("span", "json-key", JSON.stringify(key)));
    row.appendChild(el("span", "tok-punct", ": "));
  }
  row.appendChild(el("span", "tok-punct", openChar));
  const count = el("span", "muted", ` ${summary} `);
  row.appendChild(count);
  const closeInline = el("span", "tok-punct", closeChar);
  row.appendChild(closeInline);

  const children = el("div", "json-children");
  children.hidden = !startOpen;
  count.hidden = startOpen;
  closeInline.hidden = startOpen;
  for (const [k, v] of entries) {
    children.appendChild(jsonNode(isArray ? null : k, v, depth + 1));
  }
  const closeRow = el("div", "json-row");
  closeRow.appendChild(el("span", "tok-punct", closeChar));
  children.appendChild(closeRow);

  row.addEventListener("click", () => {
    const nextOpen = !!children.hidden;
    children.hidden = !nextOpen;
    chev.classList.toggle("open", nextOpen);
    count.hidden = nextOpen;
    closeInline.hidden = nextOpen;
  });

  node.appendChild(row);
  node.appendChild(children);
  return node;
}

function renderJsonTree(text: string, host: HTMLElement): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const pre = el("pre", "field-pre");
    pre.textContent = text;
    host.appendChild(pre);
    return;
  }
  const tree = el("div", "json-tree");
  tree.appendChild(jsonNode(null, value, 0));
  host.appendChild(tree);
}

// ---- markdown folding ------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function looksMarkdown(text: string): boolean {
  return text.split("\n").some((line) => HEADING_RE.test(line));
}

function renderMarkdown(text: string, host: HTMLElement): void {
  const lines = text.split("\n");
  let preamble: string[] = [];
  let current: { level: number; title: string; body: string[] } | undefined;
  const flushPreamble = () => {
    if (preamble.some((l) => l.trim())) {
      host.appendChild(el("div", "md-preamble", preamble.join("\n").trim()));
    }
    preamble = [];
  };
  const flushSection = () => {
    if (!current) return;
    const section = el("div", "md-section");
    const head = el("div", "collapse-head");
    const chev = chevron(true);
    head.appendChild(chev);
    head.appendChild(
      el("span", `md-heading ${current.level <= 1 ? "md-h1" : current.level === 2 ? "md-h2" : ""}`.trim(), current.title),
    );
    const body = el("div", "md-body", current.body.join("\n").replace(/^\n+|\n+$/g, ""));
    head.addEventListener("click", () => {
      body.hidden = !body.hidden;
      chev.classList.toggle("open", !body.hidden);
    });
    section.appendChild(head);
    section.appendChild(body);
    host.appendChild(section);
    current = undefined;
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (current) flushSection();
      else flushPreamble();
      current = { level: m[1].length, title: m[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) flushSection();
  else flushPreamble();
}

// ---- field rendering -------------------------------------------------------

function fieldBody(
  recordId: string,
  f: FieldInfo,
  body: HTMLElement,
  opts: { markdown?: boolean } = {},
): void {
  const loading = el("div", "muted", "Loading…");
  body.appendChild(loading);
  const isStructured = f.type === "object" || f.type === "array";
  const chars = f.chars ?? 0;

  // note bodies: render as real markdown (mdToHtml escapes everything first,
  // then rebuilds a small trusted tag set — no raw payload HTML gets through)
  if (opts.markdown && f.type === "string" && chars <= LOAD_ALL_MAX) {
    loadFullField(
      recordId,
      f.name,
      (text) => {
        loading.remove();
        const md = el("div", "md-rendered");
        md.innerHTML = mdToHtml(text);
        body.appendChild(md);
      },
      (message) => {
        loading.className = "err-line";
        loading.textContent = `⚠ ${message}`;
      },
    );
    return;
  }

  if (isStructured && chars <= LOAD_ALL_MAX) {
    loadFullField(
      recordId,
      f.name,
      (text) => {
        loading.remove();
        renderJsonTree(text, body);
      },
      (message) => {
        loading.className = "err-line";
        loading.textContent = `⚠ ${message}`;
      },
    );
    return;
  }

  if (f.type === "string" && chars <= LOAD_ALL_MAX) {
    loadFullField(
      recordId,
      f.name,
      (text) => {
        loading.remove();
        if (looksMarkdown(text)) renderMarkdown(text, body);
        else {
          const pre = el("pre", "field-pre");
          pre.textContent = text;
          body.appendChild(pre);
        }
      },
      (message) => {
        loading.className = "err-line";
        loading.textContent = `⚠ ${message}`;
      },
    );
    return;
  }

  // very large (or unknown) → page incrementally
  loading.remove();
  pagedText(recordId, f.name, f.type === "string" ? chars : 0, body);
}

function renderField(
  recordId: string,
  f: FieldInfo,
  opts: { markdown?: boolean } = {},
): HTMLElement {
  const chars = f.chars ?? 0;
  const metaParts = [f.type];
  if (f.size) metaParts.push(f.size);
  else if (typeof f.chars === "number") metaParts.push(`${f.chars} chars`);
  if (typeof f.count === "number") metaParts.push(`${f.count} ${f.type === "array" ? "items" : "keys"}`);

  const isStructured = f.type === "object" || f.type === "array";
  const isEmpty = !isStructured && chars === 0 && !f.count;
  const isShortScalar =
    !isStructured && chars > 0 && chars <= INLINE_PREVIEW_CHARS && f.type !== "object";

  // Markdown fields (note bodies): always the full-load path, open by default —
  // the inline preview is truncated and unstyled.
  if (opts.markdown && f.type === "string" && chars > 0) {
    return collapsible({
      headChildren: [
        el("span", "collapse-name", f.name),
        el("span", "collapse-meta", metaParts.join(" · ")),
      ],
      open: true,
      onFirstOpen: (body) => fieldBody(recordId, f, body, opts),
    });
  }

  // Short/empty scalars: show inline, no collapsible.
  if (isEmpty || isShortScalar) {
    const card = el("div", "card");
    const head = el("div", "row");
    head.appendChild(el("span", "collapse-name", f.name));
    head.appendChild(el("span", "collapse-meta", metaParts.join(" · ")));
    card.appendChild(head);
    if (isEmpty) {
      card.appendChild(el("div", "muted", "(empty)"));
    } else if (f.preview !== undefined) {
      const pre = el("pre");
      pre.textContent = f.preview;
      card.appendChild(pre);
    }
    return card;
  }

  const name = el("span", "collapse-name", f.name);
  const meta = el("span", "collapse-meta", metaParts.join(" · "));
  const preview = el("span", "collapse-preview", (f.preview ?? "").replace(/\s+/g, " ").trim());
  return collapsible({
    headChildren: [name, meta, preview],
    open: false,
    onFirstOpen: (body) => fieldBody(recordId, f, body),
  });
}

// ---- entry -----------------------------------------------------------------

export function renderRecordDetail(
  root: HTMLElement,
  state: RecordViewState,
): (msg: HostMsg) => void {
  pageHandlers.clear();
  errorHandlers.clear();

  const manifest = (state.record ?? {}) as Manifestish;
  const recordId = manifest.record ?? "";

  // --- header ---------------------------------------------------------------
  const header = el("div", "row");
  if (manifest.verb) header.appendChild(badge(manifest.verb));
  if (manifest.state) {
    const st = manifest.state;
    const cls = st === "pending" ? "state-pending" : st === "error" ? "state-error" : "state-ready";
    header.appendChild(badge(st === "pending" ? "⟳ processing" : st, cls));
  }
  const idLink = el("a", undefined, recordId || "(unknown record)");
  idLink.title = "Copy record id";
  idLink.addEventListener("click", () => post({ type: "copy", text: recordId }));
  header.appendChild(idLink);
  root.appendChild(header);

  if (manifest.state === "pending") {
    root.appendChild(
      el(
        "div",
        "pending-note",
        "This record is still being produced by its provider. Refresh the record to see the final result.",
      ),
    );
  }

  // --- two-column body: payload (left) · media (right) ----------------------
  // Both sides stay collapsible; on narrow panels the columns wrap and stack.
  const grid = el("div", "record-grid");
  const main = el("div", "record-main");
  const side = el("div", "record-side");
  grid.appendChild(main);
  grid.appendChild(side);
  root.appendChild(grid);

  // --- media column (player rendered EAGERLY — no expand-to-load) -----------
  if (manifest.media?.ref) {
    const body = el("div");
    if (state.mediaWebviewUri && state.mediaKind) {
      if (state.mediaKind === "image") {
        const img = el("img", "media-fit");
        img.src = state.mediaWebviewUri;
        body.appendChild(img);
      } else {
        const media = el(state.mediaKind === "video" ? "video" : "audio", "media-fit");
        media.controls = true;
        media.preload = "metadata";
        media.src = state.mediaWebviewUri;
        body.appendChild(media);
      }
    } else {
      body.appendChild(el("div", "muted", "No inline preview for this file."));
    }
    const ref = el("div", "media-ref muted", manifest.media.ref);
    body.appendChild(ref);
    const open = el("button", "secondary", "Open Media in Editor");
    open.addEventListener("click", () => post({ type: "openMedia" }));
    body.appendChild(open);

    const card = collapsible({
      headChildren: [el("span", "collapse-name", "Media")],
      open: true,
      onFirstOpen: (host) => host.appendChild(body),
    });
    side.appendChild(card);
  }

  // --- payload fields -------------------------------------------------------
  const fields = state.fields ?? [];
  if (fields.length > 0) {
    main.appendChild(el("div", "section-title", "Payload fields"));
    for (const f of fields) {
      // a note's text IS the record — render it as markdown, expanded
      const markdown = manifest.verb === "note" && f.name === "text";
      main.appendChild(renderField(recordId, f, { markdown }));
    }
  }

  // --- raw manifest ---------------------------------------------------------
  const details = el("details");
  details.appendChild(el("summary", "muted", "Raw record manifest"));
  const rawPre = el("pre", "field-pre");
  rawPre.textContent = JSON.stringify(state.record, null, 2);
  details.appendChild(rawPre);
  main.appendChild(details);

  // --- host message routing -------------------------------------------------
  return (msg: HostMsg) => {
    if (msg.type === "fieldPage") {
      pageHandlers.get(msg.field)?.(msg);
    } else if (msg.type === "error") {
      // errors don't name a field — surface to every field awaiting a page.
      for (const handler of [...errorHandlers.values()]) handler(msg.message);
    }
  };
}
