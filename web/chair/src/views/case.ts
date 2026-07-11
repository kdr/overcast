// Case drawer: read-only glance — scope (targets/sources), open findings,
// newest record per verb — fetched fresh each open.

import type { CaseGlance } from "../../../../src/chair/wire.js";

function item(html: { head?: string; body: string; meta?: string }): HTMLLIElement {
  const li = document.createElement("li");
  if (html.head) {
    const head = document.createElement("span");
    head.className = "verb";
    head.textContent = html.head;
    li.appendChild(head);
    li.appendChild(document.createTextNode(" "));
  }
  li.appendChild(document.createTextNode(html.body));
  if (html.meta) {
    const meta = document.createElement("div");
    meta.className = "id";
    meta.textContent = html.meta;
    li.appendChild(meta);
  }
  return li;
}

function section(panel: HTMLElement, title: string, entries: HTMLLIElement[], empty: string): void {
  const h = document.createElement("h3");
  h.textContent = title;
  panel.appendChild(h);
  const ul = document.createElement("ul");
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = empty;
    ul.appendChild(li);
  }
  for (const e of entries) ul.appendChild(e);
  panel.appendChild(ul);
}

export function openCaseDrawer(glance: CaseGlance): void {
  document.querySelector(".drawer")?.remove();
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  const panel = document.createElement("div");
  panel.className = "panel";
  drawer.appendChild(panel);

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "✕";
  close.addEventListener("click", () => drawer.remove());
  panel.appendChild(close);

  const h2 = document.createElement("h2");
  h2.textContent = `case://${glance.caseName}`;
  panel.appendChild(h2);
  const count = document.createElement("div");
  count.className = "muted";
  count.textContent = `${glance.records} records · ${Object.entries(glance.counts)
    .map(([verb, n]) => `${verb} ${n}`)
    .join(" · ")}`;
  panel.appendChild(count);

  // live situation page (pair from the desk QR — the URL carries no token)
  if (glance.situation?.running) {
    const s = glance.situation;
    const live = document.createElement("div");
    live.className = "muted";
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.url;
    live.append(`◉ SITUATION LIVE${s.every ? ` · every ${s.every}` : ""} — `, a);
    panel.appendChild(live);
  }

  section(
    panel,
    "open findings",
    glance.openFindings.map((f) => item({ body: f.text, meta: `${f.id}${f.target ? ` · ${f.target}` : ""}` })),
    "none",
  );
  section(
    panel,
    "targets",
    glance.targets.map((t) => item({ head: t.kind, body: t.value, meta: t.id })),
    "no standing targets",
  );
  section(
    panel,
    "sources",
    glance.sources.map((s) => item({ head: s.type, body: `${s.ref}${s.enabled ? "" : " (disabled)"}`, meta: s.id })),
    "no sources bound",
  );
  section(
    panel,
    "latest evidence",
    glance.latest.map((r) => item({ head: r.verb, body: r.summary, meta: `${r.id}${r.time ? ` · ${r.time}` : ""}` })),
    "no records yet",
  );

  drawer.addEventListener("click", (e) => {
    if (e.target === drawer) drawer.remove();
  });
  document.body.appendChild(drawer);
}
