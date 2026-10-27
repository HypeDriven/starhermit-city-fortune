// The look of the menus, HUD and dialogs: the browser build's paper style
// sheet, rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start, plus the built-in widgets' looks (checkboxes, selects, dialogs,
// scroll bars) in the same paper colours. High contrast and larger text are
// the runtime's (it forces the UI's colours and scales its text).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const PAPER = {
  bg: "#f2e4c8", panel: "#fff8ea", ink: "#3a2f22", accent: "#e07f3e", muted: "#7a6a52", line: "#d9c49a", focus: "#2e6fe4", danger: "#b85450",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 30.4, padding: 8, spacing: 8, radius: 10,
    text: PAPER.ink, muted: PAPER.muted, panel: PAPER.panel, control: "#ffffff", hovered: "#fff3d6",
    pressed: "#f6e6c4", field: "#ffffff", accent: PAPER.accent, focus: PAPER.focus, outline: PAPER.line,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 40,
      parts: { box: { background: "#ffffff", border: { width: 1, color: "$muted" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "#ffffff", border: { width: 1, color: "$line" }, radius: 8, minHeight: 40 },
    dialog: {
      background: [{ image: "assets/paper-grain.webp", size: [256, 256], repeat: true }, "$panel"],
      radius: 10, padding: 24, border: { width: 1, color: "$line" }, shadow: { y: 6, blur: 24, color: "#3c2d142e" },
      parts: { backdrop: { background: "#281e0f80" } },
    },
    scrollArea: { parts: { bar: { background: "$muted", radius: 4 } } },
    tooltip: { background: "$ink", text: { color: "$panel" }, radius: 6, padding: 6 },
  });
}
