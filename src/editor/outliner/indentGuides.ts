import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { INDENT_UNIT, indentWidth, isListLine, outlinerFacet } from "./blockTree";

/** Visual indent added per nesting level (on top of the raw 2-space markdown). */
const STEP_EM = 1.5;

/** Cache one line decoration per depth so equal depths share an instance. */
const decoByDepth = new Map<number, Decoration>();
function lineDeco(depth: number): Decoration {
  let d = decoByDepth.get(depth);
  if (!d) {
    d = Decoration.line({
      class: "onyx-outline-line",
      attributes: {
        style: `--onyx-depth:${depth}; padding-left:${(depth * STEP_EM).toFixed(2)}em`,
        "data-depth": String(depth),
      },
    });
    decoByDepth.set(depth, d);
  }
  return d;
}

function build(state: EditorState): DecorationSet {
  if (!state.facet(outlinerFacet)) return Decoration.none;
  const ranges = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!isListLine(line.text)) continue;
    const depth = Math.floor(indentWidth(line.text) / INDENT_UNIT.length);
    if (depth <= 0) continue;
    ranges.push(lineDeco(depth).range(line.from));
  }
  return Decoration.set(ranges, true);
}

/**
 * Gives nested bullets a generous, consistent visual indent (with a subtle
 * guide rail via CSS) regardless of the raw whitespace width. Line decorations
 * must come from a StateField, so this mirrors the render engine's whole-doc
 * scan but only runs a cheap regex per line.
 */
export const indentGuides = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.startState.facet(outlinerFacet) !== tr.state.facet(outlinerFacet)
    ) {
      return build(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
