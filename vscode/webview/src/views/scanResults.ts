// Scan results view: hit cards with Capture / Pull + Sense / Open URL actions.
// All content is set via textContent (scan hits are scraped, untrusted text —
// CLAUDE.md invariant #10). Subsequent host messages: {type:"hitStatus"}.
import type { HostMsg, ScanHit, ScanViewState } from "../../../src/shared/protocol.ts";
import { post } from "../vscodeApi.ts";

interface HitControls {
  buttons: HTMLButtonElement[];
  status: HTMLSpanElement;
}

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

function renderHit(hit: ScanHit, controls: Map<number, HitControls>): HTMLElement {
  const card = el("div", "card");

  const heading = el("div", "row");
  const title = hit.title ?? hit.url ?? hit.id ?? `hit ${hit.index + 1}`;
  if (hit.url && /^https?:\/\//i.test(hit.url)) {
    const link = el("a", undefined, title);
    link.addEventListener("click", () => post({ type: "openExternal", url: hit.url as string }));
    heading.appendChild(link);
  } else {
    heading.appendChild(el("strong", undefined, title));
  }
  card.appendChild(heading);

  const metaBits = [hit.source, hit.time, hit.url && !/^https?:\/\//i.test(hit.url) ? hit.url : undefined]
    .filter((x): x is string => !!x);
  if (metaBits.length) card.appendChild(el("div", "muted", metaBits.join(" · ")));
  if (hit.excerpt) card.appendChild(el("p", undefined, hit.excerpt));

  const actions = el("div", "row");
  const buttons: HTMLButtonElement[] = [];
  const mkButton = (
    label: string,
    action: "capture" | "pullSense" | "open",
    secondary = false,
  ): void => {
    const b = el("button", secondary ? "secondary" : undefined, label) as HTMLButtonElement;
    b.addEventListener("click", () => post({ type: "hitAction", index: hit.index, action }));
    buttons.push(b);
    actions.appendChild(b);
  };
  mkButton("Capture", "capture");
  mkButton("Pull + Sense", "pullSense");
  if (hit.url && /^https?:\/\//i.test(hit.url)) mkButton("Open URL", "open", true);
  const status = el("span", "muted");
  actions.appendChild(status);
  card.appendChild(actions);

  controls.set(hit.index, { buttons, status });
  return card;
}

export function renderScanResults(
  root: HTMLElement,
  state: ScanViewState,
): (msg: HostMsg) => void {
  const controls = new Map<number, HitControls>();

  root.appendChild(el("h2", undefined, `Scan: ${state.query}`));
  root.appendChild(
    el(
      "div",
      "muted",
      `${state.source ?? "all enabled sources"} · ${state.hits.length} hit${state.hits.length === 1 ? "" : "s"}`,
    ),
  );
  for (const hit of state.hits) root.appendChild(renderHit(hit, controls));

  return (msg: HostMsg) => {
    if (msg.type !== "hitStatus") return;
    const c = controls.get(msg.index);
    if (!c) return;
    const working = msg.status === "working";
    for (const b of c.buttons) b.disabled = working;
    c.status.textContent = "";
    c.status.className = working ? "muted" : "";
    c.status.style.color =
      msg.status === "error"
        ? "var(--vscode-errorForeground)"
        : msg.status === "done"
          ? "var(--vscode-charts-green, inherit)"
          : "";
    const prefix = working ? "⏳ " : msg.status === "done" ? "✓ " : "✖ ";
    c.status.append(prefix + (msg.note ?? msg.status));
    if (msg.status === "done" && msg.recordId) {
      const recordId = msg.recordId;
      c.status.append(" — ");
      const link = el("a", undefined, recordId);
      link.addEventListener("click", () => post({ type: "openRecord", recordId }));
      c.status.appendChild(link);
    }
  };
}
