import type { Extension } from "@codemirror/state";
import { outlinerFacet } from "./blockTree";
import { listFold } from "./fold";
import { indentGuides } from "./indentGuides";
import { foldChevrons } from "./chevron";
import { zoomExtension } from "./zoom";

export { outlinerFacet } from "./blockTree";
export { outlinerKeymap } from "./keymap";

/**
 * The block-outliner interaction layer (Logseq-style): Tab/Shift-Tab to
 * indent/outdent a bullet subtree, Enter to split, Backspace to outdent,
 * Mod-Shift-Up/Down to move, and per-bullet folding. All keys and the fold
 * service are gated on `outlinerFacet` so they no-op when the flag is off.
 * Install `outlinerKeys` *before* the default keymap (done in Editor.tsx).
 */
export function outlinerExtensions(enabled: boolean): Extension {
  return [
    outlinerFacet.of(enabled),
    listFold,
    indentGuides,
    foldChevrons,
    zoomExtension,
  ];
}
