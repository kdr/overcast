// Terminal QR rendering for chair pairing. Half-block glyphs pack two module
// rows per text row; modules render INVERTED (light modules as filled blocks,
// dark as spaces) so the mandatory light quiet zone is drawn explicitly —
// the right polarity for the usual dark terminal background, and phone
// scanners decode inverted codes fine. The tokened URL is always shown
// alongside the QR, so a failed scan still has a manual path.

import { encodeQr, type Ecc } from "./qrcodegen.js";

export interface QrRenderOptions {
  /** Light quiet-zone width in modules (spec asks for 4). */
  border?: number;
  ecc?: Ecc;
}

/** Render `text` as terminal lines of ▀▄█/space half-blocks. */
export function qrLines(text: string, opts: QrRenderOptions = {}): string[] {
  const border = opts.border ?? 4;
  const matrix = encodeQr(text, opts.ecc ?? "M");
  const size = matrix.length;
  const total = size + border * 2;
  const dark = (x: number, y: number): boolean => {
    // outside the symbol = quiet zone = light
    const mx = x - border;
    const my = y - border;
    if (mx < 0 || my < 0 || mx >= size || my >= size) return false;
    return matrix[my][mx];
  };
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = "";
    for (let x = 0; x < total; x++) {
      const topLight = !dark(x, y);
      const bottomLight = y + 1 >= total ? true : !dark(x, y + 1);
      line += topLight ? (bottomLight ? "█" : "▀") : bottomLight ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines;
}
