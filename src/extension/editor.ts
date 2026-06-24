// A thin custom editor: pi's default input has no prompt and an inverse-video
// cursor. We extend CustomEditor (which carries all app keybindings + editing)
// and only post-process render() to (1) draw a yellow `❯` prompt in the left
// padding and (2) recolor the block cursor green — matching the overcast theme.
// Everything else (typing, history, autocomplete, paste, shortcuts) is inherited.

import { CustomEditor } from "@earendil-works/pi-coding-agent";

const YELLOW = "\x1b[38;2;255;196;0m"; // #ffc400 chevron
const RESET = "\x1b[0m";
// green block cursor: green background + dark foreground (replaces the editor's
// inverse-video cursor sequence \x1b[7m…)
const GREEN_CURSOR = "\x1b[48;2;0;255;127m\x1b[38;2;8;18;12m";
const PAD = 2; // left padding columns — room for "❯ "

export class OvercastEditor extends CustomEditor {
  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    const [tui, theme, keybindings] = args;
    super(tui, theme, keybindings, { paddingX: PAD });
  }

  render(width: number): string[] {
    const lines = super.render(width);
    try {
      let chevronPlaced = false;
      return lines.map((line) => {
        // recolor the inverse-video block cursor to a green cell
        let out = line.split("\x1b[7m").join(GREEN_CURSOR);
        // place the chevron on the FIRST content line (content lines start with the
        // PAD spaces; the top/bottom border lines start with `─`). Swap the leading
        // 2-space pad for "❯ " so the line width is unchanged.
        if (!chevronPlaced && out.startsWith(" ".repeat(PAD))) {
          out = `${YELLOW}❯${RESET} ` + out.slice(PAD);
          chevronPlaced = true;
        }
        return out;
      });
    } catch {
      return lines; // never let cosmetic post-processing break the input
    }
  }
}
