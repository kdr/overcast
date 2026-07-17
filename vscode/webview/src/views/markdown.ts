// Minimal, dependency-free markdown → HTML for note bodies in the record
// detail view (no CDN / no marked). Escapes EVERYTHING first, then rebuilds a
// small trusted tag set: headings, hr, blockquote, lists, fenced + inline code,
// bold/italic/strikethrough, links (http/https only) and autolinks. Anything it
// doesn't understand stays visible as escaped text — never dropped.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline spans over already-escaped text. */
function inline(text: string): string {
  let out = text;
  // inline code first — its contents must not be styled further
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // [label](http…) — only http/https; quotes were escaped so attr is safe
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
  // bare autolink (not already inside an attribute/anchor from the pass above)
  out = out.replace(
    /(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    (_m, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`,
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
  out = out.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return out;
}

/** Render markdown text to a small trusted-tag HTML string. */
export function mdToHtml(md: string): string {
  const lines = escapeHtml(md.replace(/\r\n/g, "\n")).split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: "ul" | "ol" | undefined;
  let inCode = false;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join("<br/>")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      flushAll();
      out.push(inCode ? "</code></pre>" : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${line}\n`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6); // h1 → h3 etc (view-scaled)
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushAll();
      out.push("<hr/>");
      continue;
    }
    const quoted = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      flushQuote();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        flushList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  if (inCode) out.push("</code></pre>");
  flushAll();
  return out.join("");
}
